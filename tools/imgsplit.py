import os
from shutil import rmtree
from sys import argv
from sys import exit as exit_


argc = len(argv)
filename = None
step = 4096
args = argv[1:]
argc -= 1
zstd_path = None


for i in range(argc):
    lowered = args[i].lower()
    is_last = i == argc - 1
    if lowered == '--help' or lowered == '-h':
        print('--help - Display information.')
        print('--step {int} - Set step')
        print('--filename {path} - Set file path')
        print('--zstd_path {path} - Set path to zstd and use it')
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
    elif lowered == '--zstd_path' or lowered == '-z':
        if os.name == 'posix':
            zstd_path = 'zstd'
            if os.system(zstd_path + ' --version'):
                while True:
                    input_result = input('Install ' + zstd_path + ' [Y/n]? ').lower().strip()
                    if input_result == 'n':
                        exit_(1)
                    elif input_result == 'y':
                        os.system('sudo apt-get install zstd')
                        if os.system(zstd_path + ' --version'):
                            print(zstd_path + ' installation failed!')
                            exit_(1)
                        break
        else:
            if is_last:
                print('Argument required!')
                exit_(1)
            else:
                zstd_path = args[i + 1]

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
        while True:
            input_result = input('Out dir is not empty! Continue [Y/n]? ').lower().strip()
            if input_result == 'n':
                exit_(1)
            elif input_result == 'y':
                rmtree(out_dir)
                os.mkdir(out_dir)
                break
else:
    os.mkdir(out_dir)

opened = open(filename, 'rb')
readf = opened.read()
opened.close()
file_length = len(readf)

i = 0

while i < file_length - step:
    file_path = os.path.join(out_dir, f'{no_ext}.{ext}-{i}')
    temp_file = open(file_path, 'wb')
    temp_file.write(readf[i:i + step])
    temp_file.close()
    if zstd_path:
        cmd = f'{zstd_path} --format=zstd -o "{file_path}.zst" {file_path}'
        os.system(cmd)
        os.remove(file_path)
    i += step


file_path = os.path.join(out_dir, f'{no_ext}.{ext}-{i}.{ext}')
temp_file = open(file_path, 'wb')
temp_file.write(readf[i:file_length])
temp_file.close()
if zstd_path:
    os.system(f'{zstd_path} --format=zstd -o "{file_path}.zst" {file_path}')
    os.remove(file_path)
