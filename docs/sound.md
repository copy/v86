# Sound

v86's sound devices and the path of their samples to the page. The PC
machines have one sound card, chosen with `audio_device`, and the PC speaker;
the virt machine has virtio-snd (`virtio_sound`, [aarch64.md](aarch64.md)).

| `audio_device` | Device | Guests that drive it themselves |
| --- | --- | --- |
| `"sb16"` (default) | Sound Blaster 16 (ISA; a plugin, `build/v86-sb16.js`, source in `src/audio_devices/sb16/`) | DOS, Windows 3.x to XP (with their drivers) |
| `"hd_audio"` | Intel HD Audio controller and a generic output codec (a plugin, `build/v86-hd-audio.js`) | Windows Vista to 11 (`hdaudbus.inf`, `hdaudio.inf`), Linux (`snd-hda-intel`, the generic codec parser) |
| `"none"` | no sound card (the PC speaker stays) | |

`disable_speaker` (the page's "mute") is independent: the guest keeps its
card, the page plays nothing. In the VM manager these are the Sound card list
and its Mute checkbox; configuration version 3 turned version 2's PC sound
`"none"`, which was a muted Sound Blaster, into `sb16` with `mute` set, and
rewrites a suspended machine's digest for it ([vm-manager.md](vm-manager.md)).

Both cards are plugins, loaded beside the bundle (or from
`audio_device_path`) when the machine is made: the SB16 since stage M1 of
[modern-pc-devices-plan.md](modern-pc-devices-plan.md), with the ISA part of
the device handle (its IRQ line, the 8237's channels and fixed ports:
src/device_plugin.js). A missing plugin file fails the start and names it.

The card's state is `state[61]` of a snapshot, the plugin's slot
`["audio_device", 1, name, state]` (src/device_plugin.js). In snapshots from
before M1 (format 6 and the stream's 7) the slot is the SB16's own state,
untagged, which the SB16 plugin reads as it is. A snapshot restores only into
a machine with the same card; otherwise `restore_state` fails before it
changes anything ("The snapshot is from a machine with audio_device: …").

Since M1 snapshots have format 8, streams 9 (src/state.js; single files keep
even versions, streams odd ones: 7 was already the stream's), so that a v86
from before refuses them ("Version mismatch") instead of reading a tagged
slot as the card's registers. A v86 since M1 reads 6 and 8, streams 7 and 9.
A site that moves to it cannot go back with the saves made since. An
embedder deploys `build/v86-sb16.js` and `build/v86-ne2k.js` beside its
libv86 bundle (or names them: `audio_device_path`, `net_device.plugin_path`).

## The speaker path

Devices send their samples on the bus as `dac-send-data` (two `Float32Array`
channels in [-1, 1)), with `dac-tell-sampling-rate` when the rate changes and
`dac-enable`/`dac-disable` (src/browser/speaker.js). The page's AudioWorklet
queues the buffers (a bounded number), resamples them to the audio context's
rate and plays silence when the queue runs dry; with the CPU worker the
samples go to the worklet through its own port. A device's timing never
depends on the page: the guest's audio advances on the machine clock whether
or not the page has unlocked audio, is muted or hidden.

## HD Audio

`src/audio_devices/hd_audio/`: `controller.js` (the controller),
`codec.js` (the codec), `plugin.js`; `src/audio_devices/machine.js` is the
sound card plugins' machine (the speaker messages on top of the device
handle).

- **Controller.** ICH6's `8086:2668` (revision 1) on i440FX and ICH9's
  `8086:293E` (revision 3) on Q35, as QEMU's `intel-hda` and
  `ich9-intel-hda`; subsystem `1AF4:1100`; class 04/03/00; at 00:1b.0
  (00:04.0 with `qemu_compatible`, `pci_functions`); BAR0 16 KiB; INTA, the
  PCI power management capability, no MSI. GCAP announces one output
  stream, no input, 64-bit addresses.
- **Registers.** GCTL/CRST (in reset only GCTL is written; leaving it, the
  codec at address 0 sets STATESTS), WAKEEN, INTCTL/INTSTS, WALCLK (24 MHz
  of the machine clock), SSYNC (also at its old offset 0x34), CORB/RIRB
  (256 entries, CORBRP's reset handshake, RIRBWP's reset, RINTCNT, RINTFL),
  the immediate command registers, the DMA position buffer, the stream
  descriptor (CTL with SRST, RUN, the interrupt enables and the stream tag,
  STS, LPIB, CBL, LVI, FIFOS 0xFF, FMT, the BDL address) and the aliases at
  0x2030 and 0x2084. Any access width works: v86 splits 16-bit MMIO accesses
  into bytes, and each register is written once per access with the bytes it
  covers.
- **Commands.** The codec answers at once, through the CORB and RIRB or the
  immediate command; a command for an address without a codec gets no
  answer (the immediate command stays busy, as on hardware).
- **Codec.** QEMU's `hda-output` with its mixer: vendor `1AF4:0012`; the
  root, the audio function group, a stereo DAC (output amplifier: mute and
  74 steps of 1 dB, 0 dB at the top, so the guest's volume control acts on
  the samples) and a line out pin connected to it; 16-bit PCM at 44.1 and
  48 kHz. The verbs: parameters, connection list and select, power state,
  converter stream and channel, stream format, amplifier gain and mute, pin
  control, unsolicited enable, pin sense, EAPD, digital converter, the
  configuration default and subsystem ID bytes, the function group's reset;
  the others answer 0 (as QEMU's).
- **Streams.** A stream runs while RUN is set and SSYNC does not hold it. It
  plays at its format's rate on the machine clock: each round of the
  machine's timers reads what is due from its buffer descriptors in order
  (LPIB, wrapping at CBL; the DMA position buffer), sets BCIS at the end of a
  descriptor with IOC, and sends the samples to the speaker through the DAC
  that has the stream's tag (its gains, the pin's output enable; another tag
  plays silence). The timer comes back at the next descriptor's end, at most
  10 ms later. A round plays at most 100 ms: when the host stalled longer,
  the stream's clock goes on and the samples of the gap are not kept. A
  descriptor list it cannot use (a descriptor shorter than a frame, outside
  memory) stops the stream with DESE.
- **Snapshots.** Registers, streams (their position and the time since they
  started), the codec. The speaker is told the rate again; what it had
  queued is not replayed.
- **Tests.** `make hd-audio-tests`: `tests/devices/hd_audio.js` (the device
  through its registers, rings and descriptor lists, in ci-tests) and
  `tests/devices/hd_audio_guest.mjs`, Alpine 3.24 x86_64 with a freestanding
  ALSA player (`tests/devices/hd_audio_play.c`): the drivers bind the
  controller and the codec ("QEMU Generic", the Master controls, a PCM
  device), and 2 s at 48 kHz and 1 s at 44.1 kHz arrive as the player's
  pattern, frame for frame, in 2.0 and 1.0 s of machine time, on i440FX and
  Q35, one and two cores; with the Master controls switched on, a 1 kHz tone
  reaches the speaker at 0 dB. `tests/devices/hd_audio_browser.html` plays
  20 s of that tone in headless Chrome with the CPU worker: heard without a
  gap at the expected level and pitch, silent while the machine is paused
  (the speaker suspends its audio context then), nothing queued after the
  end. "hd-audio-pcm" bus events carry the stream's bytes as the controller
  read them (for tests).
- **Windows 8.1 x64** (Q35, two cores; `tests/x64/windows_boot.mjs` with
  `WIN_AUDIO=hd_audio`): `hdaudbus.inf` binds the controller and
  `hdaudio.inf` the codec (`HDAUDIO\FUNC_01&VEN_1AF4&DEV_0012`), both
  ConfigManagerErrorCode 0, the endpoint "Speakers (High Definition Audio
  Device)"; a system sound played with PowerShell's SoundPlayer comes
  through the controller at 44.1 kHz, 16 bits, stereo.

Not emulated yet: input streams (recording), more than one output stream,
other sample sizes and rates, MSI, unsolicited responses (jack sensing).
