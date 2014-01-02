;[BITS 32]

start:
mov ebx, 100000h

%if 1

add al, [4*ebx+100h]
add eax, ecx
add [4*ebx+1000h], cl
add al, 10h
add eax, 1000h
add cl, 10h
add ecx, 1000h

or  al, [4*ebx+100h]
or  eax, ecx
or  [4*ebx+1000h], cl
or  al, 10h
or  eax, 1000h
or  cl, 10h
or  ecx, 1000h

adc al, [4*ebx+100h]
adc eax, ecx
adc [4*ebx+1000h], cl
adc al, 10h
adc eax, 1000h
adc cl, 10h
adc ecx, 1000h

sbb al, [4*ebx+100h]
sbb eax, ecx
sbb [4*ebx+1000h], cl
sbb al, 10h
sbb eax, 1000h
sbb cl, 10h
sbb ecx, 1000h

and al, [4*ebx+100h]
and eax, ecx
and [4*ebx+1000h], cl
and al, 10h
and eax, 1000h
and cl, 10h
and ecx, 1000h

sub al, [4*ebx+100h]
sub eax, ecx
sub [4*ebx+1000h], cl
sub al, 10h
sub eax, 1000h
sub cl, 10h
sub ecx, 1000h

xor al, [4*ebx+100h]
xor eax, ecx
xor [4*ebx+1000h], cl
xor al, 10h
xor eax, 1000h
xor cl, 10h
xor ecx, 1000h

cmp al, [4*ebx+100h]
cmp eax, ecx
cmp [4*ebx+1000h], cl
cmp al, 10h
cmp eax, 1000h
cmp cl, 10h
cmp ecx, 1000h


test al, [4*ebx+100h]
test eax, ecx
test [4*ebx+1000h], cl
test al, 10h
test eax, 1000h
%endif


%if 0
add eax, 12345671h

jo $+2
jno $+2
jp $+2
jnp $+2
jc $+2
jnc $+2
js $+2
jns $+2
jz $+2
jnz $+2
jl $+2
jnl $+2
jbe $+2
jnbe $+2
jle $+2
jnle $+2
%endif

%if 0
sal eax, 12
sal cx, 7
sal dl, 1
sal dh, 0

shl eax, 12
shl cx, 7
shl dl, 1
shl dh, 0

shr eax, 12
shr cx, 7
shr dl, 1
shr dh, 0

ror eax, 12
ror cx, 7
ror dl, 1
ror dh, 0

rol eax, 12
rol cx, 7
rol dl, 1
rol dh, 0

rcr eax, 12
rcr cx, 7
rcr dl, 1
rcr dh, 0

rcl eax, 12
rcl cx, 7
rcl dl, 1
rcl dh, 0


%endif

%if 0

mov eax, -1
mov ax, -1
mov al, -1
mov al, [ebx]

movsx eax, ax
movsx ax, al
movzx eax, al

xchg eax, ecx
xchg [ebx], al
xchg [ebx], ax

inc byte [ebx]
inc dword [ebx]
inc ax
inc al
dec byte [ebx]
dec dword [ebx]
dec ax
dec al

mul ecx
mul cx
mul cl

imul ecx
imul cx
imul cl


imul eax, 10h
imul eax, 1000000h
imul ax, 10h
imul eax, ecx
imul ax, cx

push eax
push ax
pop di
pop edi

sti
cli
std
cld

pusha
popa
pushad
popad

pushf
popf
pushfd
popfd

%endif


jmp start
