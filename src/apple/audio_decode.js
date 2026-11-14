// Bounded host decoding for AMC compressed-input jobs. The device still
// owns its DMA, buffer layout and completion interrupts; this only returns
// real interleaved PCM from WebCodecs (also available in a CPU Worker).
export class AMCAudioDecoder
{
    constructor()
    {
        this.decoder = null;
        this.key = "";
        this.timestamp = 0;
        this.busy = false;
        this.output = [];
        this.failure = null;
    }

    close()
    {
        if(this.decoder && this.decoder["state"] !== "closed") this.decoder["close"]();
        this.decoder = null;
        this.key = "";
        this.output = [];
    }

    async decode(data, rate, channels, codec = "mp4a.40.2")
    {
        if(this.busy || !(data instanceof Uint8Array) || !data.length || data.length > 1 << 20 ||
            ![1, 2].includes(channels) || !Number.isInteger(rate) || rate < 7350 || rate > 96000)
            throw new Error("Invalid or overlapping AMC audio input");
        const Decoder = globalThis["AudioDecoder"], Chunk = globalThis["EncodedAudioChunk"];
        if(!Decoder || !Chunk) throw new Error("This browser has no compressed audio decoder");
        this.busy = true;
        try
        {
            const key = codec + ":" + rate + ":" + channels;
            if(key !== this.key)
            {
                this.close();
                const config = { "codec": codec, "sampleRate": rate, "numberOfChannels": channels };
                if(codec === "mp4a.40.2")
                {
                    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
                    const index = rates.indexOf(rate);
                    if(index < 0) throw new Error("Unsupported AMC AAC rate");
                    config["description"] = new Uint8Array([0x10 | index >> 1, (index & 1) << 7 | channels << 3]);
                }
                const support = await Decoder["isConfigSupported"](config);
                if(!support["supported"]) throw new Error("Unsupported AMC audio codec");
                this.decoder = new Decoder({
                    "output": frame => {
                        try
                        {
                            const n = frame["numberOfFrames"], count = frame["numberOfChannels"];
                            if(n > 8192 || count !== channels || frame["sampleRate"] !== rate || this.output.length >= 64)
                                throw new Error("AMC decoded format or output limit mismatch");
                            const pcm = new Int16Array(n * count), plane = new Float32Array(n);
                            for(let ch = 0; ch < count; ch++)
                            {
                                frame["copyTo"](plane, { "planeIndex": ch, "format": "f32-planar" });
                                for(let i = 0; i < n; i++) pcm[i * count + ch] = Math.max(-32768, Math.min(32767, Math.round(plane[i] * 32768)));
                            }
                            this.output.push(pcm);
                        }
                        catch(error) { this.failure = error; }
                        finally { frame["close"](); }
                    },
                    "error": error => { this.failure = error; },
                });
                this.decoder["configure"](config);
                this.key = key;
            }
            this.output = [];
            this.failure = null;
            this.decoder["decode"](new Chunk({ "type": "key", "timestamp": this.timestamp++, "data": data }));
            await this.decoder["flush"]();
            if(this.failure) throw this.failure;
            const size = this.output.reduce((sum, pcm) => sum + pcm.length, 0);
            if(!size || size > 1 << 19) throw new Error("AMC decoder produced no bounded PCM output");
            const samples = new Int16Array(size);
            let at = 0;
            for(const pcm of this.output) { samples.set(pcm, at); at += pcm.length; }
            return samples;
        }
        finally { this.busy = false; }
    }
}
