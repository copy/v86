def t(f, o):
    fout = open(o, 'w')
    fin = open(f)
    for line in fin:
        line = line.strip()
        if not line:
            continue
        print >> fout, line
    fin.close()

t('../src/cpu-ref.js', 'cpu-good.js')
t('../src/cpu.js', 'cpu-try.js')
