import os
from sys import argv
from sys import exit as exit_


argc = len(argv)
filename = None
step = 4096
args = argv[1:]
argc -= 1


for i in range(argc):
    lowered = args[i].lower()
    is_last = i == argc - 1
    if lowered == '--help' or lowered == '-h':
        print('--help - Display information.')
        print('--step {int} - Set step')
        print('--filename {path} - Set file path')
        exit_(0)
    elif lowered == '--step' or lowered == '-s':
        if is_last:
            print('Argument required!')
            exit_(1)
        else:
            step = int(args[i + 1])
    elif lowered == '--filename' or lowered == '-f':
        if is_last:
            print('Argument required!')
            exit_(1)
        else:
            filename = args[i + 1]

if argc <= 1 or not filename:
    print('Use --help for more information')
    exit_(1)

if not os.access(filename, os.F_OK):
    print('Could not open file!')
    exit_(1)

ext = filename.split('.')[-1]
no_ext = filename[:-len(ext) - 1].replace('\\', '/').split('/')[-1]
    
out_dir = os.path.join(os.path.dirname(filename), no_ext + '_out')


if os.path.isdir(out_dir):
    if os.listdir(out_dir):
        print('Out dir is not empty!')
        exit_(1)
else:
    os.mkdir(out_dir)

opened = open(filename, 'rb')

readf = opened.read()

file_length = len(readf)

i = 0

while i < file_length - step:
    temp_file = open(os.path.join(out_dir, f'{no_ext}-{i}.{ext}'), 'wb')
    temp_file.write(readf[i:i + step])
    temp_file.close()
    i += step


temp_file = open(os.path.join(out_dir, f'{no_ext}-{i}.{ext}'), 'wb')
temp_file.write(readf[i:file_length])
temp_file.close()

opened.close()