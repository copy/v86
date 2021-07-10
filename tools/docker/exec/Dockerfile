FROM alpine:3.14 as v86-builder
WORKDIR /v86

RUN apk add --update curl clang make openjdk8 npm python3

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && PATH="${HOME}/.cargo/bin:${PATH}" rustup target add wasm32-unknown-unknown

COPY . .

RUN PATH="${HOME}/.cargo/bin:${PATH}" make all && rm -rf closure-compiler gen lib src tools

FROM python:3.9.6-alpine3.14
WORKDIR /v86

COPY --from=v86-builder v86 .

ARG PORT=8000
CMD python3 -m http.server ${PORT}

EXPOSE ${PORT}
