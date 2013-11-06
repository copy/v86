nasm test.asm -o test.bin

echo "var file = [" > test-asm.js
cat test.bin|xxd -i >> test-asm.js
echo "]" >> test-asm.js

echo "done."

