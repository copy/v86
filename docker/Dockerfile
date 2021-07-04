# Intermediary container for building artifacts
FROM alpine:3.14 as v86-builder
WORKDIR /v86

# Install runtime dependencies for building artifacts
RUN apk add --update curl clang make openjdk8 npm python3

# Install Rustup from Official Release using Install Shell Script
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Update `PATH` variable to point to Rust Binaries (Does not work automatically) and install required Crates for the target platform
RUN PATH="${HOME}/.cargo/bin:${PATH}" rustup target add wasm32-unknown-unknown

# Copy all source files into container
COPY . .

# Build step - Should emit all the wasm and js files
RUN PATH="${HOME}/.cargo/bin:${PATH}" make all && rm -rf closure-compiler gen lib src tools

# Build runtime image
FROM python:3.9.6-alpine3.14
WORKDIR /v86

# Copy built artifacts from intermediate container
COPY --from=v86-builder v86 .

# Start Pythom HTTP Server to serve static files
ARG PORT=8000
CMD python3 -m http.server ${PORT}

# Allow external modules and clients to connect
EXPOSE ${PORT}
