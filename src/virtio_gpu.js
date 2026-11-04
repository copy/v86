import { LOG_VIRTIO } from "./const.js";
import { dbg_log } from "./log.js";
import { VirtIO, VIRTIO_F_VERSION_1 } from "./virtio.js";

// For Types Only
import { CPU } from "./cpu.js";
import { ScreenAdapter } from "./browser/screen.js";
import { DummyScreenAdapter } from "./browser/dummy_screen.js";

const VIRTIO_GPU_CMD_GET_DISPLAY_INFO = 0x0100;
const VIRTIO_GPU_CMD_RESOURCE_CREATE_2D = 0x0101;
const VIRTIO_GPU_CMD_RESOURCE_UNREF = 0x0102;
const VIRTIO_GPU_CMD_SET_SCANOUT = 0x0103;
const VIRTIO_GPU_CMD_RESOURCE_FLUSH = 0x0104;
const VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D = 0x0105;
const VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING = 0x0106;
const VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING = 0x0107;
const VIRTIO_GPU_CMD_UPDATE_CURSOR = 0x0300;
const VIRTIO_GPU_CMD_MOVE_CURSOR = 0x0301;

const VIRTIO_GPU_RESP_OK_NODATA = 0x1100;
const VIRTIO_GPU_RESP_OK_DISPLAY_INFO = 0x1101;
const VIRTIO_GPU_RESP_ERR_UNSPEC = 0x1200;

const VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM = 1;
const VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM = 2;
const VIRTIO_GPU_HEADER_SIZE = 24;
const VIRTIO_GPU_MAX_RESOURCE_SIZE = 64 * 1024 * 1024;
const VIRTIO_GPU_MAX_TOTAL_RESOURCE_SIZE = 128 * 1024 * 1024;
const VIRTIO_GPU_DEFAULT_WIDTH = 1024;
const VIRTIO_GPU_DEFAULT_HEIGHT = 768;

function read_u32(data, offset)
{
    return offset + 4 <= data.length ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true) : 0;
}

function response_header(request, type, size = VIRTIO_GPU_HEADER_SIZE)
{
    const response = new Uint8Array(size);
    const view = new DataView(response.buffer);
    view.setUint32(0, type, true);
    response.set(request.subarray(8, Math.min(request.length, VIRTIO_GPU_HEADER_SIZE)), 8);
    return response;
}

/**
 * @constructor
 * @param {CPU} cpu
 * @param {ScreenAdapter|DummyScreenAdapter} screen
 */
export function VirtioGpu(cpu, screen)
{
    this.cpu = cpu;
    this.screen = screen;
    this.resources = new Map();
    this.resource_memory_used = 0;
    this.scanout_resource = 0;

    const queues = [
        {size_supported: 64, notify_offset: 0},
        {size_supported: 16, notify_offset: 1},
    ];

    const process_queue = queue_id =>
    {
        const queue = this.virtio.queues[queue_id];
        while(queue.has_request())
        {
            const bufchain = queue.pop_request();
            const request = new Uint8Array(bufchain.length_readable);
            bufchain.get_next_blob(request);
            const response = this.process_command(request, queue_id);
            bufchain.set_next_blob(response);
            queue.push_reply(bufchain);
        }
        queue.flush_replies();
    };

    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-gpu",
        pci_id: 0x10 << 3,
        device_id: 0x1050,
        subsystem_device_id: 16,
        common:
        {
            initial_port: 0xE800,
            queues: queues,
            features: [VIRTIO_F_VERSION_1],
            on_driver_ok: () =>
            {
                this.resources.clear();
                this.resource_memory_used = 0;
                this.scanout_resource = 0;
                this.screen.clear_virtio_gpu_frame && this.screen.clear_virtio_gpu_frame();
            },
        },
        notification:
        {
            initial_port: 0xE900,
            single_handler: false,
            handlers: [process_queue, process_queue],
        },
        isr_status:
        {
            initial_port: 0xE700,
        },
        device_specific:
        {
            initial_port: 0xE600,
            struct:
            [
                {bytes: 4, name: "events_read", read: () => 0, write: data => {}},
                {bytes: 4, name: "events_clear", read: () => 0, write: data => {}},
                {bytes: 4, name: "num_scanouts", read: () => 1, write: data => {}},
                {bytes: 4, name: "num_capsets", read: () => 0, write: data => {}},
            ],
        },
    });
}

VirtioGpu.prototype.process_command = function(request, queue_id)
{
    if(request.length < VIRTIO_GPU_HEADER_SIZE)
    {
        return response_header(request, VIRTIO_GPU_RESP_ERR_UNSPEC);
    }

    const command = read_u32(request, 0);
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);

    if(queue_id === 1)
    {
        return response_header(request,
            command === VIRTIO_GPU_CMD_UPDATE_CURSOR || command === VIRTIO_GPU_CMD_MOVE_CURSOR ?
                VIRTIO_GPU_RESP_OK_NODATA : VIRTIO_GPU_RESP_ERR_UNSPEC);
    }

    switch(command)
    {
        case VIRTIO_GPU_CMD_GET_DISPLAY_INFO:
        {
            const response = response_header(request, VIRTIO_GPU_RESP_OK_DISPLAY_INFO, 24 + 16 * 24);
            const response_view = new DataView(response.buffer);
            response_view.setUint32(24 + 8, VIRTIO_GPU_DEFAULT_WIDTH, true);
            response_view.setUint32(24 + 12, VIRTIO_GPU_DEFAULT_HEIGHT, true);
            response_view.setUint32(24 + 16, 1, true);
            return response;
        }
        case VIRTIO_GPU_CMD_RESOURCE_CREATE_2D:
        {
            if(request.length < 40)
            {
                break;
            }
            const resource_id = view.getUint32(24, true);
            const format = view.getUint32(28, true);
            const width = view.getUint32(32, true);
            const height = view.getUint32(36, true);
            const byte_length = width * height * 4;
            if(!resource_id || this.resources.has(resource_id) || !width || !height ||
                byte_length > VIRTIO_GPU_MAX_RESOURCE_SIZE ||
                byte_length + this.resource_memory_used > VIRTIO_GPU_MAX_TOTAL_RESOURCE_SIZE ||
                (format !== VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM && format !== VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM))
            {
                break;
            }
            this.resources.set(resource_id,
            {
                width: width,
                height: height,
                format: format,
                pixels: new Uint8Array(byte_length),
                backing: [],
            });
            this.resource_memory_used += byte_length;
            return response_header(request, VIRTIO_GPU_RESP_OK_NODATA);
        }
        case VIRTIO_GPU_CMD_RESOURCE_UNREF:
        {
            const resource_id = read_u32(request, 24);
            const resource = this.resources.get(resource_id);
            if(resource)
            {
                this.resources.delete(resource_id);
                this.resource_memory_used -= resource.pixels.length;
            }
            if(this.scanout_resource === resource_id)
            {
                this.scanout_resource = 0;
                this.screen.clear_virtio_gpu_frame && this.screen.clear_virtio_gpu_frame();
            }
            return response_header(request, VIRTIO_GPU_RESP_OK_NODATA);
        }
        case VIRTIO_GPU_CMD_SET_SCANOUT:
        {
            if(request.length < 48 || read_u32(request, 40) !== 0)
            {
                break;
            }
            const rect_x = read_u32(request, 24);
            const rect_y = read_u32(request, 28);
            const rect_width = read_u32(request, 32);
            const rect_height = read_u32(request, 36);
            const resource_id = read_u32(request, 44);
            const resource = this.resources.get(resource_id);
            if(resource_id && (!resource || rect_x + rect_width > resource.width || rect_y + rect_height > resource.height))
            {
                break;
            }
            this.scanout_resource = resource_id;
            if(!resource_id)
            {
                this.screen.clear_virtio_gpu_frame && this.screen.clear_virtio_gpu_frame();
            }
            else if(resource)
            {
                this.screen.present_virtio_gpu_frame && this.screen.present_virtio_gpu_frame(
                    resource.width, resource.height, resource.pixels, 0, 0, resource.width, resource.height,
                    resource.format === VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM);
            }
            return response_header(request, VIRTIO_GPU_RESP_OK_NODATA);
        }
        case VIRTIO_GPU_CMD_RESOURCE_FLUSH:
        {
            const x = read_u32(request, 24);
            const y = read_u32(request, 28);
            const width = read_u32(request, 32);
            const height = read_u32(request, 36);
            const resource = this.resources.get(read_u32(request, 40));
            if(!resource || x > resource.width || y > resource.height ||
                width > resource.width - x || height > resource.height - y)
            {
                break;
            }
            if(this.scanout_resource === read_u32(request, 40))
            {
                this.screen.present_virtio_gpu_frame && this.screen.present_virtio_gpu_frame(
                    resource.width, resource.height, resource.pixels, x, y, width, height,
                    resource.format === VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM);
            }
            return response_header(request, VIRTIO_GPU_RESP_OK_NODATA);
        }
        case VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D:
        {
            if(request.length < 56)
            {
                break;
            }
            const x = read_u32(request, 24);
            const y = read_u32(request, 28);
            const width = read_u32(request, 32);
            const height = read_u32(request, 36);
            const offset_low = read_u32(request, 40);
            const offset_high = read_u32(request, 44);
            const resource = this.resources.get(read_u32(request, 48));
            if(!resource || offset_high || x > resource.width || y > resource.height ||
                width > resource.width - x || height > resource.height - y)
            {
                break;
            }
            for(let row = 0; row < height; ++row)
            {
                const source_offset = offset_low + ((y + row) * resource.width + x) * 4;
                const target_offset = ((y + row) * resource.width + x) * 4;
                if(!this.read_backing(resource, source_offset, width * 4, resource.pixels, target_offset))
                {
                    return response_header(request, VIRTIO_GPU_RESP_ERR_UNSPEC);
                }
            }
            return response_header(request, VIRTIO_GPU_RESP_OK_NODATA);
        }
        case VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING:
        {
            if(request.length < 32)
            {
                break;
            }
            const resource = this.resources.get(read_u32(request, 24));
            const num_entries = read_u32(request, 28);
            if(!resource || num_entries > 4096 || request.length < 32 + num_entries * 16)
            {
                break;
            }
            const backing = [];
            let total_length = 0;
            for(let i = 0, offset = 32; i < num_entries; ++i, offset += 16)
            {
                const addr_low = read_u32(request, offset);
                const addr_high = read_u32(request, offset + 4);
                const length = read_u32(request, offset + 8);
                const end = addr_low + length;
                if(addr_high || !length || end > this.cpu.mem8.length || end < addr_low ||
                    this.cpu.in_mapped_range(addr_low) || this.cpu.in_mapped_range(end - 1))
                {
                    break;
                }
                backing.push({addr: addr_low, length: length, offset: total_length});
                total_length += length;
            }
            if(backing.length !== num_entries || total_length < resource.pixels.length)
            {
                break;
            }
            resource.backing = backing;
            return response_header(request, VIRTIO_GPU_RESP_OK_NODATA);
        }
        case VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING:
        {
            const resource = this.resources.get(read_u32(request, 24));
            if(!resource)
            {
                break;
            }
            resource.backing = [];
            return response_header(request, VIRTIO_GPU_RESP_OK_NODATA);
        }
    }

    dbg_log("Unsupported or invalid VirtIO-GPU command: " + command.toString(16), LOG_VIRTIO);
    return response_header(request, VIRTIO_GPU_RESP_ERR_UNSPEC);
};

VirtioGpu.prototype.read_backing = function(resource, offset, length, target, target_offset = 0)
{
    const result = target || new Uint8Array(length);
    let low = 0;
    let high = resource.backing.length;
    while(low < high)
    {
        const mid = low + high >> 1;
        const segment = resource.backing[mid];
        if(segment.offset + segment.length <= offset)
        {
            low = mid + 1;
        }
        else
        {
            high = mid;
        }
    }

    let copied = 0;
    for(let i = low; copied < length && i < resource.backing.length; ++i)
    {
        const segment = resource.backing[i];
        const offset_in_segment = Math.max(0, offset + copied - segment.offset);
        const count = Math.min(length - copied, segment.length - offset_in_segment);
        if(count <= 0)
        {
            continue;
        }
        result.set(this.cpu.read_blob(segment.addr + offset_in_segment, count), target_offset + copied);
        copied += count;
    }
    return copied === length ? result : null;
};

VirtioGpu.prototype.get_state = function()
{
    return [this.virtio.get_state(), Array.from(this.resources.entries()), this.scanout_resource];
};

VirtioGpu.prototype.set_state = function(state)
{
    this.virtio.set_state(state[0]);
    this.resources = new Map(state[1]);
    this.resource_memory_used = 0;
    for(const resource of this.resources.values())
    {
        this.resource_memory_used += resource.pixels.length;
        let offset = 0;
        for(const segment of resource.backing)
        {
            segment.offset = offset;
            offset += segment.length;
        }
    }
    this.scanout_resource = state[2];
    const resource = this.resources.get(this.scanout_resource);
    if(resource)
    {
        this.screen.present_virtio_gpu_frame && this.screen.present_virtio_gpu_frame(
            resource.width, resource.height, resource.pixels, 0, 0, resource.width, resource.height,
            resource.format === VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM);
    }
};

VirtioGpu.prototype.reset = function()
{
    this.virtio.reset();
    this.resources.clear();
    this.resource_memory_used = 0;
    this.scanout_resource = 0;
    this.screen.clear_virtio_gpu_frame && this.screen.clear_virtio_gpu_frame();
};