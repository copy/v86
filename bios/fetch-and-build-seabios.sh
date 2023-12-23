set -e
git clone https://git.seabios.org/seabios.git || true
(cd seabios && git checkout rel-1.16.2)

cp seabios.config seabios/.config
make -C seabios
cp seabios/out/bios.bin seabios.bin
cp seabios/out/vgabios.bin vgabios.bin

cp seabios-debug.config seabios/.config
make -C seabios
cp seabios/out/bios.bin seabios-debug.bin
cp seabios/out/vgabios.bin vgabios-debug.bin
