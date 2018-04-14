set -e

docker build . --rm --tag i386/debian-bench
docker rm debian-bench || true
docker create -t -i --name debian-bench i386/debian-bench bash
