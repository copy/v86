# v86 Modem device

The v86 Modem device emulates a Hayes-compatible dial-up Modem connected by UART, main features:

* V.250-compatible command-line interpreter with support for a subset of the V.250 AT command set
* Full UART support (guest's output signals: DTR/RTS/TxD, input: DCD/DSR/RING/CTS/RxD)
* RTS/CTS hardware flow control, DCD online signalling, hangup on DTR low
* Online escape sequence `+++`
* WebSocket-based backend with upstream buffering
* Phonebook to simplify dial destination addresses

Limitations:

* Inbound calls (RING, ATA, S0 and S1) are currently not supported
* XON/XOFF software flow control is not implemented

## Modem setup

### Web interface setup

At **https://copy.sh/v86/**, enable the Modem by selecting a COM-Port (UART) from its menu (default: `None`).

### Code-based setup

Use the optional `modem` field in the v86 `options` Object to enable the Modem:

```javascript
const options = {
    // ...
    modem: {
        uart: 2
    },
    // ...
};
const emulator = new V86(options);
```

The `modem` field defines an Object with the supported Modem settings:

| Setting                     | Type    | Description |
| :-------------------------- | :------ | :---------- |
| **uart**                    | number  | Required, selects the UART that the Modem is connected to: 1, 2, 3 or 4 (for UART0 to UART3, respectively). The selected UART is automatically enabled in the v86 device tree. |
| **phonebook**               | Object  | Optional, maps address strings received in dial commands to WebSocket address strings. |

#### Example `modem` settings

Install Modem on UART1 and map dial address `123` to WebSocket address `wss://example.com:5678`:

```javascript
const emulator = new V86({
   // ...
   modem: {
       uart: 2,
       phonebook: {"123": "wss://example.com:5678"}
   }
});
```

## AT command interpreter

The v86 Modem behaves as described in V.250 when decoding command lines, executing commmands or when generating informational and result code messages.

All command lines share the common basic syntax:

* **AT &lt;CMD&gt;[&lt;ARG&gt;] [&lt;CMD&gt;[&lt;ARG&gt;] ...] &lt;CR&gt;**

where **&lt;CMD&gt;** is one or more non-numerical characters and **&lt;ARG&gt;** and optional sequence of digits (with the exception of the [Dial command](#dial-command) and the [S-Register commands](#s-register-commands)). All whitespace is ignored and command names are treated case-insensitive. Commands **A**, **D**, **H**, **Z** and **&F** terminate the command line, all other commands can be freely combined in any order.

Maximum accepted command line length is 256 characters.

### AT command set

This Modem emulation implements all V.250 **baseline** commands plus a few from the Telit command set (in order to simplify the command syntax).

Some commands (like **L**, **M** and **X**) have no effect in this emulation.

| Command | Description | Reference    |
| :------ | :---------- | :----------- |
| **A**   | Answer      | [V250] 6.3.5 |
| **D ... [;]**<br>**DP ... [;]**<br>**DT ... [;]** | Dial using preset dialling method, see [Dial command](#dial-command)<br>Dial using pulse dialling<br>Dial using tone dialling | [V250] 6.3.1 |
| **E[1]**<br>**E0** | Echo on (default)<br>Echo off | [V250] 6.2.4 |
| **H[0]** | Hook control | [V250] 6.3.6 |
| **I3** | Request identification information | [V250] 6.1.3 |
| **L[0-3]** | Monitor speaker loudness | [V250] 6.3.13 |
| **M[0-2]** | Monitor speaker mode | [V250] 6.3.14 |
| **O[0]** | Return to online data state | [V250] 6.3.7 |
| **P** | Select pulse dialling (default) | [V250] 6.3.3 |
| **Q[0]**<br>**Q1** | Transmit result codes (default)<br>Suppress result codes | [V250] 6.2.5 |
| **S0?, S0=`n`** | Automatic answer (default 0) | [V250] 6.3.8 |
| **S1?, S1=`n`** | Ring counter (default 0) | [TELIT] 3.5.3.6.2 |
| **S2?, S2=`n`** | Escape Character (default 43=`+`) | [TELIT] 3.5.3.6.3 |
| **S3?, S3=`n`** | Command line termination character (default 13=`\r`) | [V250] 6.2.1 |
| **S4?, S4=`n`** | Response formatting character (default 10=`\n`) | [V250] 6.2.2 |
| **S5?, S5=`n`** | Command line editing character (default 8=`\b`) | [V250] 6.2.3 |
| **T** | Select tone dialling | [V250] 6.3.2 |
| **V[0]**<br>**V1** | Limited response format<br>Verbose response format (default) | [V250] 6.2.6 |
| **X[0-4]** | Result code selection | [V250] 6.2.7 |
| **Z[0]** | Reset to default configuration | [V250] 6.1.1 |
| **&C[1]**<br>**&C0** | DCD is on when modem is online (default)<br>DCD is always on | [V250] 6.2.8 |
| **&D0**<br>**&D1**<br>**&D2** | Ignore DTR<br>DTR low: Enter command mode, stay online<br>DTR low: Enter command mode, go offline (default) | [V250] 6.2.9 |
| **&F** | Set to factory-defined configuration | [V250] 6.1.2 |
| **&K0**<br>**&K3** | Disable flow Control<br>Use RTS/CTS flow control (default) | [TELIT] 3.5.3.2.9 |

### Dial command

Dial command syntax:

* **D ["] &lt;dial-address&gt; ["] [;]**  
  Dial **&lt;dial-address&gt;** using preset dialling method, see commands **P** and **T** (default: pulse dialling)
* **DP ["] &lt;dial-address&gt; ["] [;]**  
  Dial **&lt;dial-address&gt;** using pulse dialling (`ws://`)
* **DT ["] &lt;dial-address&gt; ["] [;]**  
  Dial **&lt;dial-address&gt;** using tone dialling (`wss://`)

If the optional **;** is present at the end of the dial command then the Modem will stay in AT command mode after successfull command completion, otherwise it will switch into online data mode.

**Dial address translation**

The Modem follows these rules to translate **&lt;dial-address&gt;** into a WebSocket address string:

* It first checks whether its phonebook contains a matching entry for **&lt;dial-address&gt;** and, if it exists, uses that entry's mapped value as the WebSocket address string.
* Otherwise, if **&lt;dial-address&gt;** is an IPv4/Port-address in either dotted-IP:Port or zero-padded IP/Port notation then it is translated into an equivalent WebSocket address (the Port number is always optional). Note that in **dotted-IP:Port notation**, any non-digit and non-whitespace characters may be used as separator characters for the four IPv4 octets and the Port number. A **zero-padded IP/Port-number** is a sequence of 12 to 17 digits where the four IPv4 octets are encoded as 3-digit, zero-padded numbers followed by an optional Port number (for example, `1921680330021111` is translated into IPv4 address and Port `192.168.33.2:1111`).
* If **&lt;dial-address&gt;** is not defined in the phonebook and it is also not a digit-encoded IPv4 address, then **&lt;dial-address&gt;** is directly used as the WebSocket address string.

If the translated WebSocket address string does not already start with `ws://` or `wss://`, then

* `ws://` is prepended if **pulse dialling** is currently selected and
* `wss://` if **tone dialling** is selected.

**Dial command examples**

Assuming that:

* host name `example.com` had the IPv4 address `111.22.3.44`,
* the Modem is configured to use pulse dialling by default, and
* the Modem's phonbook is defined as `{"911": "ws://example.com:56789"}`,

then all of these dial commands will connect to same WebSocket server:

```
AT D 111.22.3.44:56789
AT D 111-22-3-44-56789
AT D example.com:56789
AT D "example.com:56789"        # NOTE: use quotes if your address starts with a "P", "T, "p" or a "t"
AT D ws://example.com:56789
AT DP ws://111.22.3.44:56789
AT DT ws://111.22.3.44:56789    # NOTE: "ws://" overrides "DT"
AT D 11102200304456789
AT D 911
```

### S-Register commands

The Modem supports several S-Registers **S0**, **S1**, ..., **S5**, use these commands for read and write access:

* **S&lt;reg&gt;?**  
  Generates a response with the current value of register **S&lt;reg&gt;** as a zero-padded, three-digit number.
* **S&lt;reg&gt;=&lt;val&gt;**  
  Sets the value of register **S&lt;reg&gt;** to **&lt;val&gt;**.

## Example WebSocket servers

A WebSocket server is required to provide a dial-in point for the v86 Modem. The bytestream from and to the Modem is transported in binary WebSocket messages. Closing the WebSocket connection corresponds to the Modem hanging up (and vice versa).

The following examples were tested under Debian GNU/Linux 12 (Bookworm). All commands used in the examples below (like `websocketd`, `pppd` etc.) are standard Debian packages.

> [!TIP]
> `websocketd` connects programs with WebSocket channels using plain pipes. Some programs (like `login` or `bash`) cannot run on a plain pipe but expect a pseudoterminal (PTY) instead (they rely on line editing and signals, for example). One possibility to create the PTY for such programs is to wrap their command line in a call to `script -qc "<CMDLINE>" /dev/null`, as used in some of the examples below.

### Example 1: login

To start a WebSocket server on port 23456 that serves a new login shell for each WebSocket client that connects use:

```bash
websocketd -binary --port 23456 script -qc "sudo TERM=$TERM login" /dev/null
```

To serve a bash shell instead that behaves like a login shell:

```bash
websocketd -binary --port 23456 script -qc "env -i HOME=$HOME TERM=$TERM PATH=/usr/bin:/bin bash -l" /dev/null
```

Of course, any suitable application can be passed to `websocketd` to execute, including any script files. Some examples besides `login` and `bash` for such applications are `lynx`, `mutt`, `telnet`, `sz` and `pppd`.

### Example 2: PPP

Demonstrates a WebSocket-PPP concentrator for up to 4 simultaneously connected Modems using `pppd`.

> [!NOTE]
> The limit of 4 connections is arbitrary, this example supports any limit in the range of 1 to 253 connections, though the method used to manage the pool gets unpractical for larger pool sizes.

Create a script file `wsppp.sh` with the following content, note the variables at the top which you will likely have to adjust to your host's environment:

```bash
#!/bin/bash

# WS_PORT: WebSocket server port number
# ETH_IF: your host's ethernet interface name, for example: "eth0"
# SUBNET: any private /24 address space that is not used on your host's network
# LOCAL_IP: should be the first IP in SUBNET (ending on ".1"), must not be used in the pool
# REMOTE_IP_POOL: pool of client IPs, any subset of the remaining IPs in SUBNET (ending on ".2" ... ".254")
WS_PORT=23456
ETH_IF=enp0s3
SUBNET=192.168.100.0/24
LOCAL_IP=192.168.100.1
REMOTE_IP_POOL=(
    192.168.100.2
    192.168.100.3
    192.168.100.4
    192.168.100.5
)

if [[ $# -gt 0 ]]; then
    # ensure that this script was invoked with command line argument "--exec-pppd"
    if [[ $# -ne 1 || "$1" != "--exec-pppd" ]]; then
        exit 1
    fi
    # fetch unused IP from pool or abort if all IPs are in use
    for i_ip in "${REMOTE_IP_POOL[@]}"; do
        if ! ip route | grep -q "$i_ip dev ppp"; then
            REMOTE_IP="$i_ip"
            break
        fi
    done
    if [[ -z "$REMOTE_IP" ]]; then
        exit 1
    fi
    # exec pppd (exec never returns), arguments:
    # - nodetach, notty, local: do not fork into background, transport is a raw stream
    # - noauth: do not require the peer to authenticate itself
    # - mtu, mru: set maximum PPP payload size to 1400 bytes to avoid TCP fragmentation
    # - asyncmap 0, escape 0: disable control character escaping
    # - noccp, nobsdcomp, nodeflate, nopcomp, noaccomp: disable compression support
    # - lcp-echo-interval 10, lcp-echo-failure 3: monitor that the peer is still reachable
    # - ms-dns <DNS-IP>: advertise DNS server to the peer
    exec pppd nodetach notty local noauth noproxyarp \
        mtu 1400 mru 1400 \
        asyncmap 0 escape 0 \
        noccp nobsdcomp nodeflate nopcomp noaccomp \
        lcp-echo-interval 10 lcp-echo-failure 3 \
        ms-dns 8.8.4.4 ms-dns 8.8.8.8 \
        "$LOCAL_IP:$REMOTE_IP"
fi

# install common NAT rules for all PPP interfaces (ppp0, ppp1, ...), remove rules when this script exits
cleanup() {
    iptables -t nat -D POSTROUTING -o "$ETH_IF" -s "$SUBNET" -j MASQUERADE
    iptables -D FORWARD -i ppp+ -o "$ETH_IF" -j ACCEPT
    iptables -D FORWARD -i "$ETH_IF" -o ppp+ -m state --state RELATED,ESTABLISHED -j ACCEPT
}
trap cleanup EXIT

sysctl -q net.ipv4.ip_forward=1
iptables -t nat -A POSTROUTING -o "$ETH_IF" -s "$SUBNET" -j MASQUERADE
iptables -A FORWARD -i ppp+ -o "$ETH_IF" -j ACCEPT
iptables -A FORWARD -i "$ETH_IF" -o ppp+ -m state --state RELATED,ESTABLISHED -j ACCEPT

# execute websocketd, limit number of simultaneous WebSocket connections to tbe pool size
# for each accepted WebSocket connection, execute this script again but with command line option "--exec-pppd"
websocketd -binary --maxforks ${#REMOTE_IP_POOL[@]} --port $WS_PORT "$0" --exec-pppd
```

Make the script executable using `chmod +x wsppp.sh`, then start the WebSocket server as root using:

```bash
sudo ./wsppp.sh
```

## Links

* [V250] [V.250: Serial asynchronous automatic dialling and control](https://www.itu.int/rec/T-REC-V.250-200307-I/en)
* [TELIT] [AT Commands Reference Guide](https://docs.rs-online.com/c5f6/0900766b81541066.pdf)
* [websocketd](http://websocketd.com/), also [websockify](https://linux.die.net/man/1/websockify)
* [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
* [WebRTC API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
