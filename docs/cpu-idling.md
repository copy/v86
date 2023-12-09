Some operating systems don't support `hlt` instruction, because of this, the CPU spin loops instead of idling.
Here are some solutions for different OSes:

## MS-DOS (using DOSIdle)
1. Download `DOSID251.zip` from https://www.vogons.org/viewtopic.php?p=438763#p438763
2. Unzip DOSIDLE.EXE from archive in any location (recommended to root of C:).
3. Run `edit C:\autoexec.bat`
4. Add to file: `C:\path\to\dosidle.exe`
5. Save changes (*press Alt + F and x*) and restart the VM.

**Note:** To hide output when starting DOSIdle, change `C:\path\to\dosidle.exe` to `C:\path\to\dosidle.exe > nul` on step №4.

## FreeDOS ([source](https://narkive.com/UGrcO8wU.2))
1. Run `edit C:\fdconfig.sys` (or `edit C:\config.sys`)
2. Add to file: `IDLEHALT=1`
3. Save changes (*press Alt + F and x*) and restart FreeDOS.

## Windows 9x (using AmnHLT)
1. Download `amnhltm.zip` from http://toogam.com/software/archive/drivers/cpu/cpuidle/amnhltm.zip ([mirror](https://web.archive.org/web/20060212132151/http://www.user.cityline.ru/~maxamn/amnhltm.zip))
2. Unzip the archive in any location.
3. **Note**: If you have installed VBE9x, restart Windows, press F8 on boot, select *Command prompt only*, run `cd C:\path\to\amnhlt\`, and follow to the next step.
4. Run `AMNHLT.BAT`
5. Restart Windows, and AmnHLT will start automatically on next boot (you can safely delete archive and unpacked folder).

## Windows 98+ and Unix-like
These systems are already supports `hlt`, no further action is required.
