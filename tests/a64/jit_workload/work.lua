-- The guest JIT workload's LuaJIT part (tests/a64/linux_boot.mjs,
-- A64_WORKLOAD=jit; P6.7), run with -jon and -joff: the same line both ways
local s = 0
for i = 1, 3000000 do s = (s * 31 + i) % 1000000007 end
local t = {}
for i = 1, 100000 do t[i] = (i * 7919) % 100003 end
table.sort(t)
local acc = 0
for i = 1, #t, 97 do acc = (acc + t[i] * i) % 1000000007 end
local parts = {}
for i = 1, 5000 do parts[#parts + 1] = string.format("%x", (i * 2654435761) % 4294967296) end
local str = table.concat(parts, ",")
local letters = 0
for w in str:gmatch("[a-f]+") do letters = letters + #w end
local f = 0.0
for i = 1, 200000 do f = f + math.sin(i) / i end
print(string.format("luajit %d %d %d %d %.12g", s, acc, #str, letters, f))
