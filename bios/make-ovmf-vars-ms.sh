#!/bin/sh
# The Secure Boot firmware's variable store with Microsoft's keys enrolled
# (docs/uefi.md): ovmf-vars-ms.fd, made from the empty template
# (ovmf-vars.fd) by tools/uefi_vars.mjs with these files of
# microsoft/secureboot_objects at a pinned commit, each checked:
#   PK   Windows OEM Devices PK (the PK Microsoft gives OEM devices: no
#        private key here; Microsoft signs KEK updates for it)
#   KEK  Microsoft Corporation KEK CA 2011, KEK 2K CA 2023
#   db   Microsoft Windows Production PCA 2011, Windows UEFI CA 2023,
#        Microsoft Corporation UEFI CA 2011, Microsoft UEFI CA 2023 (third-party
#        boot loaders: shim), Microsoft Option ROM UEFI CA 2023
#   dbx  the signature lists of Microsoft's dbx update (DBXUpdate.bin, amd64)
# Their license (BSD-2-Clause-Patent) goes to SECUREBOOT-OBJECTS-LICENSE.txt.
#   bios/make-ovmf-vars-ms.sh [checkout of secureboot_objects]
set -eu

COMMIT=586ca9475c079377a2fe1f15fb73329f470eb281
FILES="
2f569e8edaf9657dc4951c29598725255c7f821472db71374211fe44d082546f PreSignedObjects/PK/Certificate/WindowsOEMDevicesPK.der
a1117f516a32cefcba3f2d1ace10a87972fd6bbe8fe0d0b996e09e65d802a503 PreSignedObjects/KEK/Certificates/MicCorKEKCA2011_2011-06-24.der
3cd3f0309edae228767a976dd40d9f4affc4fbd5218f2e8cc3c9dd97e8ac6f9d PreSignedObjects/KEK/Certificates/microsoft corporation kek 2k ca 2023.der
e8e95f0733a55e8bad7be0a1413ee23c51fcea64b3c8fa6a786935fddcc71961 PreSignedObjects/DB/Certificates/MicWinProPCA2011_2011-10-19.der
48e99b991f57fc52f76149599bff0a58c47154229b9f8d603ac40d3500248507 PreSignedObjects/DB/Certificates/MicCorUEFCA2011_2011-06-27.der
076f1fea90ac29155ebf77c17682f75f1fdd1be196da302dc8461e350a9ae330 PreSignedObjects/DB/Certificates/windows uefi ca 2023.der
f6124e34125bee3fe6d79a574eaa7b91c0e7bd9d929c1a321178efd611dad901 PreSignedObjects/DB/Certificates/microsoft uefi ca 2023.der
e5be3e64c6e66a281457ecdece0d6d0787577aad2a3a0144262c10c14ba8d8f1 PreSignedObjects/DB/Certificates/microsoft option rom uefi ca 2023.der
2089e3125e611376cb44326b5765674255443b2484f88de97251939d18055f68 PostSignedObjects/DBX/amd64/DBXUpdate.bin
"

here=$(cd "$(dirname "$0")" && pwd)
objects=${1:-}
if [ -z "$objects" ]
then
    objects=$(mktemp -d)
    trap 'rm -rf "$objects"' EXIT
    echo "$FILES" | while read -r sum file
    do
        [ -n "$file" ] || continue
        mkdir -p "$objects/$(dirname "$file")"
        curl -fsSL -o "$objects/$file" "https://raw.githubusercontent.com/microsoft/secureboot_objects/$COMMIT/$(echo "$file" | sed 's/ /%20/g')"
    done
    curl -fsSL -o "$objects/License.txt" "https://raw.githubusercontent.com/microsoft/secureboot_objects/$COMMIT/License.txt"
fi

echo "$FILES" | while read -r sum file
do
    [ -n "$file" ] || continue
    actual=$(shasum -a 256 "$objects/$file" | cut -d" " -f1)
    if [ "$actual" != "$sum" ]
    then
        echo "$file: sha256 $actual, expected $sum" >&2
        exit 1
    fi
done

node "$here/../tools/uefi_vars.mjs" microsoft "$objects" "$here/ovmf-vars.fd" "$here/ovmf-vars-ms.fd"
{
    echo "ovmf-vars-ms.fd: keys and revocations from microsoft/secureboot_objects $COMMIT (bios/make-ovmf-vars-ms.sh)"
    echo
    cat "$objects/License.txt"
} > "$here/SECUREBOOT-OBJECTS-LICENSE.txt"
echo "ovmf-vars-ms.fd: $(shasum -a 256 "$here/ovmf-vars-ms.fd" | cut -d" " -f1)"
