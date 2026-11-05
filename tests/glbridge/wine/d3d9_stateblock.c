/*
 * Copyright (C) 2005 Henri Verbeet
 * Copyright (C) 2006 Ivan Gyurdiev
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301, USA
 */

#define COBJMACROS
#include <d3d9.h>
#include "wine/test.h"

static DWORD texture_stages;

/* ============================ State Testing Framework ========================== */

struct state_test
{
    const char* test_name;

    /* The initial data is usually the same
     * as the default data, but a write can have side effects.
     * The initial data is tested first, before any writes take place
     * The default data can be tested after a write */
    const void* initial_data;

    /* The default data is the standard state to compare
     * against, and restore to */
    const void* default_data;

    /* The test data is the experiment data to try
     * in - what we want to write
     * out - what windows will actually write (not necessarily the same)  */
    const void *test_data_in;
    const void *test_data_out_all;
    const void *test_data_out_vertex;
    const void *test_data_out_pixel;

    HRESULT (*init)(IDirect3DDevice9 *device, struct state_test *test);
    void (*cleanup)(IDirect3DDevice9 *device, struct state_test *test);
    void (*apply_data)(IDirect3DDevice9 *device, const struct state_test *test,
            const void *data);
    void (*check_data)(IDirect3DDevice9 *device, const struct state_test *test,
            const void *expected_data, unsigned int chain_stage, DWORD quirk);

    /* Test arguments */
    const void* test_arg;

    /* Test-specific context data */
    void* test_context;
};

#define EVENT_OK    0
#define EVENT_ERROR -1

/* Apparently recorded stateblocks record and apply vertex declarations,
 * but don't capture them */
#define SB_QUIRK_RECORDED_VDECL_CAPTURE  0x00000001
#define SB_QUIRK_STREAM_OFFSET_NOT_UPDATED 0x00000002

struct event_data
{
    IDirect3DStateBlock9 *stateblock;
    IDirect3DSurface9 *original_render_target;
    IDirect3DSwapChain9 *new_swap_chain;
};

enum stateblock_data
{
    SB_DATA_NONE = 0,
    SB_DATA_DEFAULT,
    SB_DATA_INITIAL,
    SB_DATA_TEST_IN,
    SB_DATA_TEST_ALL,
    SB_DATA_TEST_VERTEX,
    SB_DATA_TEST_PIXEL,
};

struct event
{
    int (*event_fn)(IDirect3DDevice9 *device, struct event_data *event_data);
    enum stateblock_data check;
    enum stateblock_data apply;
    DWORD quirk;
};

static const void *get_event_data(const struct state_test *test, enum stateblock_data data)
{
    switch (data)
    {
        case SB_DATA_DEFAULT:
            return test->default_data;

        case SB_DATA_INITIAL:
            return test->initial_data;

        case SB_DATA_TEST_IN:
            return test->test_data_in;

        case SB_DATA_TEST_ALL:
            return test->test_data_out_all;

        case SB_DATA_TEST_VERTEX:
            return test->test_data_out_vertex;

        case SB_DATA_TEST_PIXEL:
            return test->test_data_out_pixel;

        default:
            return NULL;
    }
}

/* This is an event-machine, which tests things.
 * It tests get and set operations for a batch of states, based on
 * results from the event function, which directs what's to be done */

static void execute_test_chain(IDirect3DDevice9 *device, struct state_test *test,
        unsigned int ntests, struct event *event, unsigned int nevents, struct event_data *event_data)
{
    unsigned int i, j;

    /* For each queued event */
    for (j = 0; j < nevents; ++j)
    {
        const void *data;

        trace("event %u.\n", j);
        /* Execute the next event handler (if available). */
        if (event[j].event_fn)
        {
            if (event[j].event_fn(device, event_data) == EVENT_ERROR)
            {
                trace("Stage %u in error state, aborting.\n", j);
                break;
            }
        }

        if (event[j].check != SB_DATA_NONE)
        {
            for (i = 0; i < ntests; ++i)
            {
                data = get_event_data(&test[i], event[j].check);
                test[i].check_data(device, &test[i], data, j, event[j].quirk);
            }
        }

        if (event[j].apply != SB_DATA_NONE)
        {
            for (i = 0; i < ntests; ++i)
            {
                data = get_event_data(&test[i], event[j].apply);
                test[i].apply_data(device, &test[i], data);
            }
        }
    }

    /* Attempt to reset any changes made. */
    for (i = 0; i < ntests; ++i)
    {
        test[i].apply_data(device, &test[i], test[i].default_data);
    }
}

static int switch_render_target(IDirect3DDevice9 *device, struct event_data *event_data)
{
    HRESULT hret;
    D3DPRESENT_PARAMETERS present_parameters;
    IDirect3DSwapChain9* swapchain = NULL;
    IDirect3DSurface9* backbuffer = NULL;

    /* Parameters for new swapchain */
    ZeroMemory(&present_parameters, sizeof(present_parameters));
    present_parameters.Windowed = TRUE;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;

    /* Create new swapchain */
    hret = IDirect3DDevice9_CreateAdditionalSwapChain(device, &present_parameters, &swapchain);
    ok (hret == D3D_OK, "CreateAdditionalSwapChain returned %#lx.\n", hret);
    if (hret != D3D_OK) goto error;

    /* Get its backbuffer */
    hret = IDirect3DSwapChain9_GetBackBuffer(swapchain, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok (hret == D3D_OK, "GetBackBuffer returned %#lx.\n", hret);
    if (hret != D3D_OK) goto error;

    /* Save the current render target */
    hret = IDirect3DDevice9_GetRenderTarget(device, 0, &event_data->original_render_target);
    ok (hret == D3D_OK, "GetRenderTarget returned %#lx.\n", hret);
    if (hret != D3D_OK) goto error;

    /* Set the new swapchain's backbuffer as a render target */
    hret = IDirect3DDevice9_SetRenderTarget(device, 0, backbuffer);
    ok (hret == D3D_OK, "SetRenderTarget returned %#lx.\n", hret);
    if (hret != D3D_OK) goto error;

    IDirect3DSurface9_Release(backbuffer);
    event_data->new_swap_chain = swapchain;
    return EVENT_OK;

    error:
    if (backbuffer) IDirect3DSurface9_Release(backbuffer);
    if (swapchain) IDirect3DSwapChain9_Release(swapchain);
    return EVENT_ERROR;
}

static int revert_render_target(IDirect3DDevice9 *device, struct event_data *event_data)
{
    HRESULT hret;

    /* Reset the old render target */
    hret = IDirect3DDevice9_SetRenderTarget(device, 0, event_data->original_render_target);
    ok (hret == D3D_OK, "SetRenderTarget returned %#lx.\n", hret);
    if (hret != D3D_OK) {
        IDirect3DSurface9_Release(event_data->original_render_target);
        return EVENT_ERROR;
    }

    IDirect3DSurface9_Release(event_data->original_render_target);
    IDirect3DSwapChain9_Release(event_data->new_swap_chain);

    return EVENT_OK;
}

static int create_stateblock_all(IDirect3DDevice9 *device, struct event_data *event_data)
{
    HRESULT hr;

    hr = IDirect3DDevice9_CreateStateBlock(device, D3DSBT_ALL, &event_data->stateblock);
    ok(SUCCEEDED(hr), "CreateStateBlock returned %#lx.\n", hr);
    if (FAILED(hr)) return EVENT_ERROR;
    return EVENT_OK;
}

static int create_stateblock_vertex(IDirect3DDevice9 *device, struct event_data *event_data)
{
    HRESULT hr;

    hr = IDirect3DDevice9_CreateStateBlock(device, D3DSBT_VERTEXSTATE, &event_data->stateblock);
    ok(SUCCEEDED(hr), "CreateStateBlock returned %#lx.\n", hr);
    if (FAILED(hr)) return EVENT_ERROR;
    return EVENT_OK;
}

static int create_stateblock_pixel(IDirect3DDevice9 *device, struct event_data *event_data)
{
    HRESULT hr;

    hr = IDirect3DDevice9_CreateStateBlock(device, D3DSBT_PIXELSTATE, &event_data->stateblock);
    ok(SUCCEEDED(hr), "CreateStateBlock returned %#lx.\n", hr);
    if (FAILED(hr)) return EVENT_ERROR;
    return EVENT_OK;
}

static int begin_stateblock(IDirect3DDevice9 *device, struct event_data *event_data)
{
    HRESULT hret;

    hret = IDirect3DDevice9_BeginStateBlock(device);
    ok(hret == D3D_OK, "BeginStateBlock returned %#lx.\n", hret);
    if (hret != D3D_OK) return EVENT_ERROR;
    return EVENT_OK;
}

static int end_stateblock(IDirect3DDevice9 *device, struct event_data *event_data)
{
    HRESULT hret;

    hret = IDirect3DDevice9_EndStateBlock(device, &event_data->stateblock);
    ok(hret == D3D_OK, "EndStateBlock returned %#lx.\n", hret);
    if (hret != D3D_OK) return EVENT_ERROR;
    return EVENT_OK;
}

static int release_stateblock(IDirect3DDevice9 *device, struct event_data *event_data)
{
    IDirect3DStateBlock9_Release(event_data->stateblock);
    return EVENT_OK;
}

static int apply_stateblock(IDirect3DDevice9 *device, struct event_data *event_data)
{
    HRESULT hret;

    hret = IDirect3DStateBlock9_Apply(event_data->stateblock);
    ok(hret == D3D_OK, "Apply returned %#lx.\n", hret);
    if (hret != D3D_OK) {
        IDirect3DStateBlock9_Release(event_data->stateblock);
        return EVENT_ERROR;
    }

    IDirect3DStateBlock9_Release(event_data->stateblock);

    return EVENT_OK;
}

static int capture_stateblock(IDirect3DDevice9 *device, struct event_data *event_data)
{
    HRESULT hret;

    hret = IDirect3DStateBlock9_Capture(event_data->stateblock);
    ok(hret == D3D_OK, "Capture returned %#lx.\n", hret);
    if (hret != D3D_OK)
        return EVENT_ERROR;

    return EVENT_OK;
}

static void execute_test_chain_all(IDirect3DDevice9 *device, struct state_test *test, unsigned int ntests)
{
    struct event_data arg;
    unsigned int i;
    HRESULT hr;

    struct event read_events[] =
    {
        {NULL,                      SB_DATA_INITIAL,        SB_DATA_NONE},
    };

    struct event write_read_events[] =
    {
        {NULL,                      SB_DATA_NONE,           SB_DATA_TEST_IN},
        {NULL,                      SB_DATA_TEST_ALL,       SB_DATA_NONE},
    };

    struct event abort_stateblock_events[] =
    {
        {begin_stateblock,          SB_DATA_NONE,           SB_DATA_TEST_IN},
        {end_stateblock,            SB_DATA_NONE,           SB_DATA_NONE},
        {release_stateblock,        SB_DATA_DEFAULT,        SB_DATA_NONE},
    };

    struct event apply_stateblock_events[] =
    {
        {begin_stateblock,          SB_DATA_NONE,           SB_DATA_TEST_IN},
        {end_stateblock,            SB_DATA_NONE,           SB_DATA_NONE},
        {apply_stateblock,          SB_DATA_TEST_ALL,       SB_DATA_NONE},
    };

    struct event capture_reapply_stateblock_events[] =
    {
        {begin_stateblock,          SB_DATA_NONE,           SB_DATA_TEST_IN},
        {end_stateblock,            SB_DATA_NONE,           SB_DATA_DEFAULT},
        {capture_stateblock,        SB_DATA_DEFAULT,        SB_DATA_TEST_IN},
        {capture_stateblock,        SB_DATA_TEST_ALL,       SB_DATA_DEFAULT},
        {apply_stateblock,          SB_DATA_TEST_ALL,       SB_DATA_DEFAULT, SB_QUIRK_RECORDED_VDECL_CAPTURE},
    };

    struct event create_stateblock_capture_apply_all_events[] =
    {
        {create_stateblock_all,     SB_DATA_DEFAULT,        SB_DATA_TEST_IN},
        {capture_stateblock,        SB_DATA_TEST_ALL,       SB_DATA_DEFAULT},
        {apply_stateblock,          SB_DATA_TEST_ALL,       SB_DATA_NONE, SB_QUIRK_STREAM_OFFSET_NOT_UPDATED},
    };

    struct event create_stateblock_apply_all_events[] =
    {
        {NULL,                      SB_DATA_DEFAULT,        SB_DATA_TEST_IN},
        {create_stateblock_all,     SB_DATA_TEST_ALL,       SB_DATA_DEFAULT},
        {apply_stateblock,          SB_DATA_TEST_ALL,       SB_DATA_NONE},
    };

    struct event create_stateblock_capture_apply_vertex_events[] =
    {
        {create_stateblock_vertex,  SB_DATA_DEFAULT,        SB_DATA_TEST_IN},
        {capture_stateblock,        SB_DATA_TEST_ALL,       SB_DATA_DEFAULT},
        {apply_stateblock,          SB_DATA_TEST_VERTEX,    SB_DATA_NONE},
    };

    struct event create_stateblock_apply_vertex_events[] =
    {
        {NULL,                      SB_DATA_DEFAULT,        SB_DATA_TEST_IN},
        {create_stateblock_vertex,  SB_DATA_TEST_ALL,       SB_DATA_DEFAULT},
        {apply_stateblock,          SB_DATA_TEST_VERTEX,    SB_DATA_NONE},
    };

    struct event create_stateblock_capture_apply_pixel_events[] =
    {
        {create_stateblock_pixel,   SB_DATA_DEFAULT,        SB_DATA_TEST_IN},
        {capture_stateblock,        SB_DATA_TEST_ALL,       SB_DATA_DEFAULT},
        {apply_stateblock,          SB_DATA_TEST_PIXEL,     SB_DATA_NONE},
    };

    struct event create_stateblock_apply_pixel_events[] =
    {
        {NULL,                      SB_DATA_DEFAULT,        SB_DATA_TEST_IN},
        {create_stateblock_pixel,   SB_DATA_TEST_ALL,       SB_DATA_DEFAULT},
        {apply_stateblock,          SB_DATA_TEST_PIXEL,     SB_DATA_NONE},
    };

    struct event rendertarget_switch_events[] =
    {
        {NULL,                      SB_DATA_NONE,           SB_DATA_TEST_IN},
        {switch_render_target,      SB_DATA_TEST_ALL,       SB_DATA_NONE},
        {revert_render_target,      SB_DATA_NONE,           SB_DATA_NONE},
    };

    struct event rendertarget_stateblock_events[] =
    {
        {begin_stateblock,          SB_DATA_NONE,           SB_DATA_TEST_IN},
        {switch_render_target,      SB_DATA_DEFAULT,        SB_DATA_NONE},
        {end_stateblock,            SB_DATA_NONE,           SB_DATA_NONE},
        {revert_render_target,      SB_DATA_NONE,           SB_DATA_NONE},
        {apply_stateblock,          SB_DATA_TEST_ALL,       SB_DATA_NONE},
    };

    /* Setup each test for execution */
    for (i = 0; i < ntests; ++i)
    {
        hr = test[i].init(device, &test[i]);
        ok(SUCCEEDED(hr), "Test \"%s\" failed setup, aborting\n", test[i].test_name);
        if (FAILED(hr)) return;
    }

    trace("Running initial read state tests\n");
    execute_test_chain(device, test, ntests, read_events, ARRAY_SIZE(read_events), NULL);

    trace("Running write-read state tests\n");
    execute_test_chain(device, test, ntests, write_read_events, ARRAY_SIZE(write_read_events), NULL);

    trace("Running stateblock abort state tests\n");
    execute_test_chain(device, test, ntests, abort_stateblock_events, ARRAY_SIZE(abort_stateblock_events), &arg);

    trace("Running stateblock apply state tests\n");
    execute_test_chain(device, test, ntests, apply_stateblock_events, ARRAY_SIZE(apply_stateblock_events), &arg);

    trace("Running stateblock capture/reapply state tests\n");
    execute_test_chain(device, test, ntests, capture_reapply_stateblock_events,
            ARRAY_SIZE(capture_reapply_stateblock_events), &arg);

    trace("Running create stateblock capture/apply all state tests\n");
    execute_test_chain(device, test, ntests, create_stateblock_capture_apply_all_events,
            ARRAY_SIZE(create_stateblock_capture_apply_all_events), &arg);

    trace("Running create stateblock apply state all tests\n");
    execute_test_chain(device, test, ntests, create_stateblock_apply_all_events,
            ARRAY_SIZE(create_stateblock_apply_all_events), &arg);

    trace("Running create stateblock capture/apply vertex state tests\n");
    execute_test_chain(device, test, ntests, create_stateblock_capture_apply_vertex_events,
            ARRAY_SIZE(create_stateblock_capture_apply_vertex_events), &arg);

    trace("Running create stateblock apply vertex state tests\n");
    execute_test_chain(device, test, ntests, create_stateblock_apply_vertex_events,
            ARRAY_SIZE(create_stateblock_apply_vertex_events), &arg);

    trace("Running create stateblock capture/apply pixel state tests\n");
    execute_test_chain(device, test, ntests, create_stateblock_capture_apply_pixel_events,
            ARRAY_SIZE(create_stateblock_capture_apply_pixel_events), &arg);

    trace("Running create stateblock apply pixel state tests\n");
    execute_test_chain(device, test, ntests, create_stateblock_apply_pixel_events,
            ARRAY_SIZE(create_stateblock_apply_pixel_events), &arg);

    trace("Running rendertarget switch state tests\n");
    execute_test_chain(device, test, ntests, rendertarget_switch_events,
            ARRAY_SIZE(rendertarget_switch_events), &arg);

    trace("Running stateblock apply over rendertarget switch interrupt tests\n");
    execute_test_chain(device, test, ntests, rendertarget_stateblock_events,
            ARRAY_SIZE(rendertarget_stateblock_events), &arg);

    /* Cleanup resources */
    for (i = 0; i < ntests; ++i)
    {
        if (test[i].cleanup) test[i].cleanup(device, &test[i]);
    }
}

/* =================== State test: Pixel and Vertex Shader constants ============ */

struct shader_constant_data
{
    int int_constant[4];     /* 1x4 integer constant */
    float float_constant[4]; /* 1x4 float constant */
    BOOL bool_constant[4];   /* 4x1 boolean constants */
};

struct shader_constant_arg
{
    unsigned int idx;
    BOOL pshader;
};

static const struct shader_constant_data shader_constant_poison_data =
{
    {0x1337c0de, 0x1337c0de, 0x1337c0de, 0x1337c0de},
    {1.0f, 2.0f, 3.0f, 4.0f},
    {FALSE, TRUE, FALSE, TRUE},
};

static const struct shader_constant_data shader_constant_default_data =
{
    {0, 0, 0, 0},
    {0.0f, 0.0f, 0.0f, 0.0f},
    {0, 0, 0, 0},
};

static const struct shader_constant_data shader_constant_test_data =
{
    {0xdead0000, 0xdead0001, 0xdead0002, 0xdead0003},
    {5.0f, 6.0f, 7.0f, 8.0f},
    {TRUE, FALSE, FALSE, TRUE},
};

static void shader_constant_apply_data(IDirect3DDevice9 *device, const struct state_test *test, const void *data)
{
    const struct shader_constant_arg *scarg = test->test_arg;
    const struct shader_constant_data *scdata = data;
    HRESULT hret;
    unsigned int index = scarg->idx;

    if (!scarg->pshader) {
        hret = IDirect3DDevice9_SetVertexShaderConstantI(device, index, scdata->int_constant, 1);
        ok(hret == D3D_OK, "SetVertexShaderConstantI returned %#lx.\n", hret);
        hret = IDirect3DDevice9_SetVertexShaderConstantF(device, index, scdata->float_constant, 1);
        ok(hret == D3D_OK, "SetVertexShaderConstantF returned %#lx.\n", hret);
        hret = IDirect3DDevice9_SetVertexShaderConstantB(device, index, scdata->bool_constant, 4);
        ok(hret == D3D_OK, "SetVertexShaderConstantB returned %#lx.\n", hret);

    } else {
        hret = IDirect3DDevice9_SetPixelShaderConstantI(device, index, scdata->int_constant, 1);
        ok(hret == D3D_OK, "SetPixelShaderConstantI returned %#lx.\n", hret);
        hret = IDirect3DDevice9_SetPixelShaderConstantF(device, index, scdata->float_constant, 1);
        ok(hret == D3D_OK, "SetPixelShaderConstantF returned %#lx.\n", hret);
        hret = IDirect3DDevice9_SetPixelShaderConstantB(device, index, scdata->bool_constant, 4);
        ok(hret == D3D_OK, "SetPixelShaderConstantB returned %#lx.\n", hret);
    }
}

static void shader_constant_check_data(IDirect3DDevice9 *device, const struct state_test *test,
        const void *expected_data, unsigned int chain_stage, DWORD quirk)
{
    struct shader_constant_data value = shader_constant_poison_data;
    const struct shader_constant_data *scdata = expected_data;
    const struct shader_constant_arg *scarg = test->test_arg;
    HRESULT hr;

    if (!scarg->pshader)
    {
        hr = IDirect3DDevice9_GetVertexShaderConstantI(device, scarg->idx, value.int_constant, 1);
        ok(SUCCEEDED(hr), "GetVertexShaderConstantI returned %#lx.\n", hr);
        hr = IDirect3DDevice9_GetVertexShaderConstantF(device, scarg->idx, value.float_constant, 1);
        ok(SUCCEEDED(hr), "GetVertexShaderConstantF returned %#lx.\n", hr);
        hr = IDirect3DDevice9_GetVertexShaderConstantB(device, scarg->idx, value.bool_constant, 4);
        ok(SUCCEEDED(hr), "GetVertexShaderConstantB returned %#lx.\n", hr);
    }
    else
    {
        hr = IDirect3DDevice9_GetPixelShaderConstantI(device, scarg->idx, value.int_constant, 1);
        ok(SUCCEEDED(hr), "GetPixelShaderConstantI returned %#lx.\n", hr);
        hr = IDirect3DDevice9_GetPixelShaderConstantF(device, scarg->idx, value.float_constant, 1);
        ok(SUCCEEDED(hr), "GetPixelShaderConstantF returned %#lx.\n", hr);
        hr = IDirect3DDevice9_GetPixelShaderConstantB(device, scarg->idx, value.bool_constant, 4);
        ok(SUCCEEDED(hr), "GetPixelShaderConstantB returned %#lx.\n", hr);
    }

    ok(!memcmp(scdata->int_constant, value.int_constant, sizeof(scdata->int_constant)),
            "Chain stage %u, %s integer constant:\n"
            "\t{%#x, %#x, %#x, %#x} expected\n"
            "\t{%#x, %#x, %#x, %#x} received\n",
            chain_stage, scarg->pshader ? "pixel shader" : "vertex_shader",
            scdata->int_constant[0], scdata->int_constant[1],
            scdata->int_constant[2], scdata->int_constant[3],
            value.int_constant[0], value.int_constant[1],
            value.int_constant[2], value.int_constant[3]);

    ok(!memcmp(scdata->float_constant, value.float_constant, sizeof(scdata->float_constant)),
            "Chain stage %u, %s float constant:\n"
            "\t{%.8e, %.8e, %.8e, %.8e} expected\n"
            "\t{%.8e, %.8e, %.8e, %.8e} received\n",
            chain_stage, scarg->pshader ? "pixel shader" : "vertex_shader",
            scdata->float_constant[0], scdata->float_constant[1],
            scdata->float_constant[2], scdata->float_constant[3],
            value.float_constant[0], value.float_constant[1],
            value.float_constant[2], value.float_constant[3]);

    ok(!memcmp(scdata->bool_constant, value.bool_constant, sizeof(scdata->bool_constant)),
            "Chain stage %u, %s boolean constant:\n"
            "\t{%#x, %#x, %#x, %#x} expected\n"
            "\t{%#x, %#x, %#x, %#x} received\n",
            chain_stage, scarg->pshader ? "pixel shader" : "vertex_shader",
            scdata->bool_constant[0], scdata->bool_constant[1],
            scdata->bool_constant[2], scdata->bool_constant[3],
            value.bool_constant[0], value.bool_constant[1],
            value.bool_constant[2], value.bool_constant[3]);
}

static HRESULT shader_constant_test_init(IDirect3DDevice9 *device, struct state_test *test)
{
    const struct shader_constant_arg *test_arg = test->test_arg;

    test->test_context = NULL;
    test->test_data_in = &shader_constant_test_data;
    test->test_data_out_all = &shader_constant_test_data;
    if (test_arg->pshader)
    {
        test->test_data_out_vertex = &shader_constant_default_data;
        test->test_data_out_pixel = &shader_constant_test_data;
    }
    else
    {
        test->test_data_out_vertex = &shader_constant_test_data;
        test->test_data_out_pixel = &shader_constant_default_data;
    }
    test->default_data = &shader_constant_default_data;
    test->initial_data = &shader_constant_default_data;

    return D3D_OK;
}

static void shader_constants_queue_test(struct state_test *test, const struct shader_constant_arg *test_arg)
{
    test->init = shader_constant_test_init;
    test->cleanup = NULL;
    test->apply_data = shader_constant_apply_data;
    test->check_data = shader_constant_check_data;
    test->test_name = test_arg->pshader ? "set_get_pshader_constants" : "set_get_vshader_constants";
    test->test_arg = test_arg;
}

/* =================== State test: Lights ===================================== */

struct light_data
{
    D3DLIGHT9 light;
    BOOL enabled;
    HRESULT get_light_result;
    HRESULT get_enabled_result;
};

struct light_arg
{
    unsigned int idx;
};

static const struct light_data light_poison_data =
{
    {
        0x1337c0de,
        {7.0f, 4.0f, 2.0f, 1.0f},
        {7.0f, 4.0f, 2.0f, 1.0f},
        {7.0f, 4.0f, 2.0f, 1.0f},
        {3.3f, 4.4f, 5.5f},
        {6.6f, 7.7f, 8.8f},
        12.12f, 13.13f, 14.14f, 15.15f, 16.16f, 17.17f, 18.18f,
    },
    TRUE,
    0x1337c0de,
    0x1337c0de,
};


static const struct light_data light_default_data =
{
    {
        D3DLIGHT_DIRECTIONAL,
        {1.0f, 1.0f, 1.0f, 0.0f},
        {0.0f, 0.0f, 0.0f, 0.0f},
        {0.0f, 0.0f, 0.0f, 0.0f},
        {0.0f, 0.0f, 0.0f},
        {0.0f, 0.0f, 1.0f},
        0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
    },
    FALSE,
    D3D_OK,
    D3D_OK,
};

/* This is used for the initial read state (before a write causes side effects).
 * The proper return status is D3DERR_INVALIDCALL. */
static const struct light_data light_initial_data =
{
    {
        0x1337c0de,
        {7.0f, 4.0f, 2.0f, 1.0f},
        {7.0f, 4.0f, 2.0f, 1.0f},
        {7.0f, 4.0f, 2.0f, 1.0f},
        {3.3f, 4.4f, 5.5f},
        {6.6f, 7.7f, 8.8f},
        12.12f, 13.13f, 14.14f, 15.15f, 16.16f, 17.17f, 18.18f,
    },
    TRUE,
    D3DERR_INVALIDCALL,
    D3DERR_INVALIDCALL,
};

static const struct light_data light_test_data_in =
{
    {
        1,
        {2.0f, 2.0f, 2.0f, 2.0f},
        {3.0f, 3.0f, 3.0f, 3.0f},
        {4.0f, 4.0f, 4.0f, 4.0f},
        {5.0f, 5.0f, 5.0f},
        {6.0f, 6.0f, 6.0f},
        7.0f, 8.0f, 9.0f, 10.0f, 11.0f, 12.0f, 13.0f,
    },
    TRUE,
    D3D_OK,
    D3D_OK
};

/* SetLight will use 128 as the "enabled" value */
static const struct light_data light_test_data_out =
{
    {
        1,
        {2.0f, 2.0f, 2.0f, 2.0f},
        {3.0f, 3.0f, 3.0f, 3.0f},
        {4.0f, 4.0f, 4.0f, 4.0f},
        {5.0f, 5.0f, 5.0f},
        {6.0f, 6.0f, 6.0f},
        7.0f, 8.0f, 9.0f, 10.0f, 11.0f, 12.0f, 13.0f,
    },
    128,
    D3D_OK,
    D3D_OK,
};

static void light_apply_data(IDirect3DDevice9 *device, const struct state_test *test, const void *data)
{
    const struct light_arg *larg = test->test_arg;
    const struct light_data *ldata = data;
    HRESULT hret;
    unsigned int index = larg->idx;

    hret = IDirect3DDevice9_SetLight(device, index, &ldata->light);
    ok(hret == D3D_OK, "SetLight returned %#lx.\n", hret);

    hret = IDirect3DDevice9_LightEnable(device, index, ldata->enabled);
    ok(hret == D3D_OK, "SetLightEnable returned %#lx.\n", hret);
}

static void light_check_data(IDirect3DDevice9 *device, const struct state_test *test,
        const void *expected_data, unsigned int chain_stage, DWORD quirk)
{
    const struct light_arg *larg = test->test_arg;
    const struct light_data *ldata = expected_data;
    struct light_data value;

    value = light_poison_data;

    value.get_enabled_result = IDirect3DDevice9_GetLightEnable(device, larg->idx, &value.enabled);
    value.get_light_result = IDirect3DDevice9_GetLight(device, larg->idx, &value.light);

    ok(value.get_enabled_result == ldata->get_enabled_result,
            "Chain stage %u: expected get_enabled_result %#lx, got %#lx.\n",
            chain_stage, ldata->get_enabled_result, value.get_enabled_result);
    ok(value.get_light_result == ldata->get_light_result,
            "Chain stage %u: expected get_light_result %#lx, got %#lx.\n",
            chain_stage, ldata->get_light_result, value.get_light_result);

    ok(value.enabled == ldata->enabled,
            "Chain stage %u: expected enabled %#x, got %#x.\n",
            chain_stage, ldata->enabled, value.enabled);
    ok(value.light.Type == ldata->light.Type,
            "Chain stage %u: expected light.Type %#x, got %#x.\n",
            chain_stage, ldata->light.Type, value.light.Type);
    ok(!memcmp(&value.light.Diffuse, &ldata->light.Diffuse, sizeof(value.light.Diffuse)),
            "Chain stage %u, light.Diffuse:\n\t{%.8e, %.8e, %.8e, %.8e} expected\n"
            "\t{%.8e, %.8e, %.8e, %.8e} received.\n", chain_stage,
            ldata->light.Diffuse.r, ldata->light.Diffuse.g,
            ldata->light.Diffuse.b, ldata->light.Diffuse.a,
            value.light.Diffuse.r, value.light.Diffuse.g,
            value.light.Diffuse.b, value.light.Diffuse.a);
    ok(!memcmp(&value.light.Specular, &ldata->light.Specular, sizeof(value.light.Specular)),
            "Chain stage %u, light.Specular:\n\t{%.8e, %.8e, %.8e, %.8e} expected\n"
            "\t{%.8e, %.8e, %.8e, %.8e} received.\n", chain_stage,
            ldata->light.Specular.r, ldata->light.Specular.g,
            ldata->light.Specular.b, ldata->light.Specular.a,
            value.light.Specular.r, value.light.Specular.g,
            value.light.Specular.b, value.light.Specular.a);
    ok(!memcmp(&value.light.Ambient, &ldata->light.Ambient, sizeof(value.light.Ambient)),
            "Chain stage %u, light.Ambient:\n\t{%.8e, %.8e, %.8e, %.8e} expected\n"
            "\t{%.8e, %.8e, %.8e, %.8e} received.\n", chain_stage,
            ldata->light.Ambient.r, ldata->light.Ambient.g,
            ldata->light.Ambient.b, ldata->light.Ambient.a,
            value.light.Ambient.r, value.light.Ambient.g,
            value.light.Ambient.b, value.light.Ambient.a);
    ok(!memcmp(&value.light.Position, &ldata->light.Position, sizeof(value.light.Position)),
            "Chain stage %u, light.Position:\n\t{%.8e, %.8e, %.8e} expected\n\t{%.8e, %.8e, %.8e} received.\n",
            chain_stage, ldata->light.Position.x, ldata->light.Position.y, ldata->light.Position.z,
            value.light.Position.x, value.light.Position.y, value.light.Position.z);
    ok(!memcmp(&value.light.Direction, &ldata->light.Direction, sizeof(value.light.Direction)),
            "Chain stage %u, light.Direction:\n\t{%.8e, %.8e, %.8e} expected\n\t{%.8e, %.8e, %.8e} received.\n",
            chain_stage, ldata->light.Direction.x, ldata->light.Direction.y, ldata->light.Direction.z,
            value.light.Direction.x, value.light.Direction.y, value.light.Direction.z);
    ok(value.light.Range == ldata->light.Range,
            "Chain stage %u: expected light.Range %.8e, got %.8e.\n",
            chain_stage, ldata->light.Range, value.light.Range);
    ok(value.light.Falloff == ldata->light.Falloff,
            "Chain stage %u: expected light.Falloff %.8e, got %.8e.\n",
            chain_stage, ldata->light.Falloff, value.light.Falloff);
    ok(value.light.Attenuation0 == ldata->light.Attenuation0,
            "Chain stage %u: expected light.Attenuation0 %.8e, got %.8e.\n",
            chain_stage, ldata->light.Attenuation0, value.light.Attenuation0);
    ok(value.light.Attenuation1 == ldata->light.Attenuation1,
            "Chain stage %u: expected light.Attenuation1 %.8e, got %.8e.\n",
            chain_stage, ldata->light.Attenuation1, value.light.Attenuation1);
    ok(value.light.Attenuation2 == ldata->light.Attenuation2,
            "Chain stage %u: expected light.Attenuation2 %.8e, got %.8e.\n",
            chain_stage, ldata->light.Attenuation2, value.light.Attenuation2);
    ok(value.light.Theta == ldata->light.Theta,
            "Chain stage %u: expected light.Theta %.8e, got %.8e.\n",
            chain_stage, ldata->light.Theta, value.light.Theta);
    ok(value.light.Phi == ldata->light.Phi,
            "Chain stage %u: expected light.Phi %.8e, got %.8e.\n",
            chain_stage, ldata->light.Phi, value.light.Phi);
}

static HRESULT light_test_init(IDirect3DDevice9 *device, struct state_test *test)
{
    test->test_context = NULL;
    test->test_data_in = &light_test_data_in;
    test->test_data_out_all = &light_test_data_out;
    test->test_data_out_vertex = &light_test_data_out;
    test->test_data_out_pixel = &light_default_data;
    test->default_data = &light_default_data;
    test->initial_data = &light_initial_data;

    return D3D_OK;
}

static void lights_queue_test(struct state_test *test, const struct light_arg *test_arg)
{
    test->init = light_test_init;
    test->cleanup = NULL;
    test->apply_data = light_apply_data;
    test->check_data = light_check_data;
    test->test_name = "set_get_light";
    test->test_arg = test_arg;
}

/* =================== State test: Transforms ===================================== */

struct transform_data
{
    D3DMATRIX view;
    D3DMATRIX projection;
    D3DMATRIX texture0;
    D3DMATRIX texture7;
    D3DMATRIX world0;
    D3DMATRIX world255;
};

static const struct transform_data transform_default_data =
{
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}},
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}},
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}},
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}},
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}},
    {{{
        1.0f, 0.0f, 0.0f, 0.0f,
        0.0f, 1.0f, 0.0f, 0.0f,
        0.0f, 0.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    }}},
};

static const struct transform_data transform_poison_data =
{
    {{{
         1.0f,  2.0f,  3.0f,  4.0f,
         5.0f,  6.0f,  7.0f,  8.0f,
         9.0f, 10.0f, 11.0f, 12.0f,
        13.0f, 14.0f, 15.0f, 16.0f,
    }}},
    {{{
        17.0f, 18.0f, 19.0f, 20.0f,
        21.0f, 22.0f, 23.0f, 24.0f,
        25.0f, 26.0f, 27.0f, 28.0f,
        29.0f, 30.0f, 31.0f, 32.0f,
    }}},
    {{{
        33.0f, 34.0f, 35.0f, 36.0f,
        37.0f, 38.0f, 39.0f, 40.0f,
        41.0f, 42.0f, 43.0f, 44.0f,
        45.0f, 46.0f, 47.0f, 48.0f
    }}},
    {{{
        49.0f, 50.0f, 51.0f, 52.0f,
        53.0f, 54.0f, 55.0f, 56.0f,
        57.0f, 58.0f, 59.0f, 60.0f,
        61.0f, 62.0f, 63.0f, 64.0f,
    }}},
    {{{
        64.0f, 66.0f, 67.0f, 68.0f,
        69.0f, 70.0f, 71.0f, 72.0f,
        73.0f, 74.0f, 75.0f, 76.0f,
        77.0f, 78.0f, 79.0f, 80.0f,
    }}},
    {{{
        81.0f, 82.0f, 83.0f, 84.0f,
        85.0f, 86.0f, 87.0f, 88.0f,
        89.0f, 90.0f, 91.0f, 92.0f,
        93.0f, 94.0f, 95.0f, 96.0f,
    }}},
};

static const struct transform_data transform_test_data =
{
    {{{
          1.2f,     3.4f,  -5.6f,  7.2f,
        10.11f,  -12.13f, 14.15f, -1.5f,
        23.56f,   12.89f, 44.56f, -1.0f,
          2.3f,     0.0f,   4.4f,  5.5f,
    }}},
    {{{
          9.2f,    38.7f,  -6.6f,  7.2f,
        10.11f,  -12.13f, 77.15f, -1.5f,
        23.56f,   12.89f, 14.56f, -1.0f,
         12.3f,     0.0f,   4.4f,  5.5f,
    }}},
    {{{
         10.2f,     3.4f,   0.6f,  7.2f,
        10.11f,  -12.13f, 14.15f, -1.5f,
        23.54f,    12.9f, 44.56f, -1.0f,
          2.3f,     0.0f,   4.4f,  5.5f,
    }}},
    {{{
          1.2f,     3.4f,  -5.6f,  7.2f,
        10.11f,  -12.13f, -14.5f, -1.5f,
         2.56f,   12.89f, 23.56f, -1.0f,
        112.3f,     0.0f,   4.4f,  2.5f,
    }}},
    {{{
          1.2f,   31.41f,  58.6f,  7.2f,
        10.11f,  -12.13f, -14.5f, -1.5f,
         2.56f,   12.89f, 11.56f, -1.0f,
        112.3f,     0.0f,  44.4f,  2.5f,
    }}},
    {{{
         1.20f,     3.4f,  -5.6f,  7.0f,
        10.11f, -12.156f, -14.5f, -1.5f,
         2.56f,   1.829f,  23.6f, -1.0f,
        112.3f,     0.0f,  41.4f,  2.5f,
    }}},
};

static void transform_apply_data(IDirect3DDevice9 *device, const struct state_test *test, const void *data)
{
    const struct transform_data *tdata = data;
    HRESULT hret;

    hret = IDirect3DDevice9_SetTransform(device, D3DTS_VIEW, &tdata->view);
    ok(hret == D3D_OK, "SetTransform returned %#lx.\n", hret);

    hret = IDirect3DDevice9_SetTransform(device, D3DTS_PROJECTION, &tdata->projection);
    ok(hret == D3D_OK, "SetTransform returned %#lx.\n", hret);

    hret = IDirect3DDevice9_SetTransform(device, D3DTS_TEXTURE0, &tdata->texture0);
    ok(hret == D3D_OK, "SetTransform returned %#lx.\n", hret);

    hret = IDirect3DDevice9_SetTransform(device, D3DTS_TEXTURE0 + texture_stages - 1, &tdata->texture7);
    ok(hret == D3D_OK, "SetTransform returned %#lx.\n", hret);

    hret = IDirect3DDevice9_SetTransform(device, D3DTS_WORLD, &tdata->world0);
    ok(hret == D3D_OK, "SetTransform returned %#lx.\n", hret);

    hret = IDirect3DDevice9_SetTransform(device, D3DTS_WORLDMATRIX(255), &tdata->world255);
    ok(hret == D3D_OK, "SetTransform returned %#lx.\n", hret);
}

static void compare_matrix(const char *name, unsigned int chain_stage,
        const D3DMATRIX *received, const D3DMATRIX *expected)
{
    ok(!memcmp(expected, received, sizeof(*expected)),
            "Chain stage %u, matrix %s:\n"
            "\t{\n"
            "\t\t%.8e, %.8e, %.8e, %.8e,\n"
            "\t\t%.8e, %.8e, %.8e, %.8e,\n"
            "\t\t%.8e, %.8e, %.8e, %.8e,\n"
            "\t\t%.8e, %.8e, %.8e, %.8e,\n"
            "\t} expected\n"
            "\t{\n"
            "\t\t%.8e, %.8e, %.8e, %.8e,\n"
            "\t\t%.8e, %.8e, %.8e, %.8e,\n"
            "\t\t%.8e, %.8e, %.8e, %.8e,\n"
            "\t\t%.8e, %.8e, %.8e, %.8e,\n"
            "\t} received\n",
            chain_stage, name,
            expected->m[0][0], expected->m[1][0], expected->m[2][0], expected->m[3][0],
            expected->m[0][1], expected->m[1][1], expected->m[2][1], expected->m[3][1],
            expected->m[0][2], expected->m[1][2], expected->m[2][2], expected->m[3][2],
            expected->m[0][3], expected->m[1][3], expected->m[2][3], expected->m[3][3],
            received->m[0][0], received->m[1][0], received->m[2][0], received->m[3][0],
            received->m[0][1], received->m[1][1], received->m[2][1], received->m[3][1],
            received->m[0][2], received->m[1][2], received->m[2][2], received->m[3][2],
            received->m[0][3], received->m[1][3], received->m[2][3], received->m[3][3]);
}

static void transform_check_data(IDirect3DDevice9 *device, const struct state_test *test,
        const void *expected_data, unsigned int chain_stage, DWORD quirk)
{
    const struct transform_data *tdata = expected_data;
    D3DMATRIX value;
    HRESULT hr;

    value = transform_poison_data.view;
    hr = IDirect3DDevice9_GetTransform(device, D3DTS_VIEW, &value);
    ok(SUCCEEDED(hr), "GetTransform returned %#lx.\n", hr);
    compare_matrix("View", chain_stage, &value, &tdata->view);

    value = transform_poison_data.projection;
    hr = IDirect3DDevice9_GetTransform(device, D3DTS_PROJECTION, &value);
    ok(SUCCEEDED(hr), "GetTransform returned %#lx.\n", hr);
    compare_matrix("Projection", chain_stage, &value, &tdata->projection);

    value = transform_poison_data.texture0;
    hr = IDirect3DDevice9_GetTransform(device, D3DTS_TEXTURE0, &value);
    ok(SUCCEEDED(hr), "GetTransform returned %#lx.\n", hr);
    compare_matrix("Texture0", chain_stage, &value, &tdata->texture0);

    value = transform_poison_data.texture7;
    hr = IDirect3DDevice9_GetTransform(device, D3DTS_TEXTURE0 + texture_stages - 1, &value);
    ok(SUCCEEDED(hr), "GetTransform returned %#lx.\n", hr);
    compare_matrix("Texture7", chain_stage, &value, &tdata->texture7);

    value = transform_poison_data.world0;
    hr = IDirect3DDevice9_GetTransform(device, D3DTS_WORLD, &value);
    ok(SUCCEEDED(hr), "GetTransform returned %#lx.\n", hr);
    compare_matrix("World0", chain_stage, &value, &tdata->world0);

    value = transform_poison_data.world255;
    hr = IDirect3DDevice9_GetTransform(device, D3DTS_WORLDMATRIX(255), &value);
    ok(SUCCEEDED(hr), "GetTransform returned %#lx.\n", hr);
    compare_matrix("World255", chain_stage, &value, &tdata->world255);
}

static HRESULT transform_test_init(IDirect3DDevice9 *device, struct state_test *test)
{
    test->test_context = NULL;
    test->test_data_in = &transform_test_data;
    test->test_data_out_all = &transform_test_data;
    test->test_data_out_vertex = &transform_default_data;
    test->test_data_out_pixel = &transform_default_data;
    test->default_data = &transform_default_data;
    test->initial_data = &transform_default_data;

    return D3D_OK;
}

static void transform_queue_test(struct state_test *test)
{
    test->init = transform_test_init;
    test->cleanup = NULL;
    test->apply_data = transform_apply_data;
    test->check_data = transform_check_data;
    test->test_name = "set_get_transforms";
    test->test_arg = NULL;
}

/* =================== State test: Render States ===================================== */

const D3DRENDERSTATETYPE render_state_indices[] =
{
    D3DRS_ZENABLE,
    D3DRS_FILLMODE,
    D3DRS_SHADEMODE,
    D3DRS_ZWRITEENABLE,
    D3DRS_ALPHATESTENABLE,
    D3DRS_LASTPIXEL,
    D3DRS_SRCBLEND,
    D3DRS_DESTBLEND,
    D3DRS_CULLMODE,
    D3DRS_ZFUNC,
    D3DRS_ALPHAREF,
    D3DRS_ALPHAFUNC,
    D3DRS_DITHERENABLE,
    D3DRS_ALPHABLENDENABLE,
    D3DRS_FOGENABLE,
    D3DRS_SPECULARENABLE,
    D3DRS_FOGCOLOR,
    D3DRS_FOGTABLEMODE,
    D3DRS_FOGSTART,
    D3DRS_FOGEND,
    D3DRS_FOGDENSITY,
    D3DRS_RANGEFOGENABLE,
    D3DRS_STENCILENABLE,
    D3DRS_STENCILFAIL,
    D3DRS_STENCILZFAIL,
    D3DRS_STENCILPASS,
    D3DRS_STENCILFUNC,
    D3DRS_STENCILREF,
    D3DRS_STENCILMASK,
    D3DRS_STENCILWRITEMASK,
    D3DRS_TEXTUREFACTOR,
    D3DRS_WRAP0,
    D3DRS_WRAP1,
    D3DRS_WRAP2,
    D3DRS_WRAP3,
    D3DRS_WRAP4,
    D3DRS_WRAP5,
    D3DRS_WRAP6,
    D3DRS_WRAP7,
    D3DRS_CLIPPING,
    D3DRS_LIGHTING,
    D3DRS_AMBIENT,
    D3DRS_FOGVERTEXMODE,
    D3DRS_COLORVERTEX,
    D3DRS_LOCALVIEWER,
    D3DRS_NORMALIZENORMALS,
    D3DRS_DIFFUSEMATERIALSOURCE,
    D3DRS_SPECULARMATERIALSOURCE,
    D3DRS_AMBIENTMATERIALSOURCE,
    D3DRS_EMISSIVEMATERIALSOURCE,
    D3DRS_VERTEXBLEND,
    D3DRS_CLIPPLANEENABLE,
#if 0 /* Driver dependent */
    D3DRS_POINTSIZE,
#endif
    D3DRS_POINTSIZE_MIN,
    D3DRS_POINTSPRITEENABLE,
    D3DRS_POINTSCALEENABLE,
    D3DRS_POINTSCALE_A,
    D3DRS_POINTSCALE_B,
    D3DRS_POINTSCALE_C,
    D3DRS_MULTISAMPLEANTIALIAS,
    D3DRS_MULTISAMPLEMASK,
    D3DRS_PATCHEDGESTYLE,
#if 0 /* Apparently not recorded in the stateblock */
    D3DRS_DEBUGMONITORTOKEN,
#endif
    D3DRS_POINTSIZE_MAX,
    D3DRS_INDEXEDVERTEXBLENDENABLE,
    D3DRS_COLORWRITEENABLE,
    D3DRS_TWEENFACTOR,
    D3DRS_BLENDOP,
    D3DRS_POSITIONDEGREE,
    D3DRS_NORMALDEGREE,
    D3DRS_SCISSORTESTENABLE,
    D3DRS_SLOPESCALEDEPTHBIAS,
    D3DRS_ANTIALIASEDLINEENABLE,
    D3DRS_MINTESSELLATIONLEVEL,
    D3DRS_MAXTESSELLATIONLEVEL,
    D3DRS_ADAPTIVETESS_X,
    D3DRS_ADAPTIVETESS_Y,
    D3DRS_ADAPTIVETESS_Z,
    D3DRS_ADAPTIVETESS_W,
    D3DRS_ENABLEADAPTIVETESSELLATION,
    D3DRS_TWOSIDEDSTENCILMODE,
    D3DRS_CCW_STENCILFAIL,
    D3DRS_CCW_STENCILZFAIL,
    D3DRS_CCW_STENCILPASS,
    D3DRS_CCW_STENCILFUNC,
    D3DRS_COLORWRITEENABLE1,
    D3DRS_COLORWRITEENABLE2,
    D3DRS_COLORWRITEENABLE3,
    D3DRS_BLENDFACTOR,
    D3DRS_SRGBWRITEENABLE,
    D3DRS_DEPTHBIAS,
    D3DRS_WRAP8,
    D3DRS_WRAP9,
    D3DRS_WRAP10,
    D3DRS_WRAP11,
    D3DRS_WRAP12,
    D3DRS_WRAP13,
    D3DRS_WRAP14,
    D3DRS_WRAP15,
    D3DRS_SEPARATEALPHABLENDENABLE,
    D3DRS_SRCBLENDALPHA,
    D3DRS_DESTBLENDALPHA,
    D3DRS_BLENDOPALPHA,
};

struct render_state_data
{
    DWORD states[ARRAY_SIZE(render_state_indices)];
};

struct render_state_arg
{
    D3DPRESENT_PARAMETERS *device_pparams;
    float pointsize_max;
};

struct render_state_context
{
    struct render_state_data default_data_buffer;
    struct render_state_data test_data_all_buffer;
    struct render_state_data test_data_vertex_buffer;
    struct render_state_data test_data_pixel_buffer;
    struct render_state_data poison_data_buffer;
};

static void render_state_apply_data(IDirect3DDevice9 *device, const struct state_test *test, const void *data)
{
    const struct render_state_data *rsdata = data;
    HRESULT hret;
    unsigned int i;

    for (i = 0; i < ARRAY_SIZE(render_state_indices); ++i)
    {
        hret = IDirect3DDevice9_SetRenderState(device, render_state_indices[i], rsdata->states[i]);
        ok(hret == D3D_OK, "SetRenderState returned %#lx.\n", hret);
    }
}

static void render_state_check_data(IDirect3DDevice9 *device, const struct state_test *test,
        const void *expected_data, unsigned int chain_stage, DWORD quirk)
{
    const struct render_state_context *ctx = test->test_context;
    const struct render_state_data *rsdata = expected_data;
    unsigned int i;
    HRESULT hr;

    for (i = 0; i < ARRAY_SIZE(render_state_indices); ++i)
    {
        DWORD value = ctx->poison_data_buffer.states[i];
        hr = IDirect3DDevice9_GetRenderState(device, render_state_indices[i], &value);
        ok(SUCCEEDED(hr), "GetRenderState returned %#lx.\n", hr);
        ok(value == rsdata->states[i], "Chain stage %u, render state %#x: expected %#lx, got %#lx.\n",
                chain_stage, render_state_indices[i], rsdata->states[i], value);
    }
}

static inline DWORD to_dword(float fl) {
    return *((DWORD*) &fl);
}

static void render_state_default_data_init(const struct render_state_arg *rsarg, struct render_state_data *data)
{
   DWORD zenable = rsarg->device_pparams->EnableAutoDepthStencil ? D3DZB_TRUE : D3DZB_FALSE;
   unsigned int idx = 0;

   data->states[idx++] = zenable;               /* ZENABLE */
   data->states[idx++] = D3DFILL_SOLID;         /* FILLMODE */
   data->states[idx++] = D3DSHADE_GOURAUD;      /* SHADEMODE */
   data->states[idx++] = TRUE;                  /* ZWRITEENABLE */
   data->states[idx++] = FALSE;                 /* ALPHATESTENABLE */
   data->states[idx++] = TRUE;                  /* LASTPIXEL */
   data->states[idx++] = D3DBLEND_ONE;          /* SRCBLEND */
   data->states[idx++] = D3DBLEND_ZERO;         /* DESTBLEND */
   data->states[idx++] = D3DCULL_CCW;           /* CULLMODE */
   data->states[idx++] = D3DCMP_LESSEQUAL;      /* ZFUNC */
   data->states[idx++] = 0;                     /* ALPHAREF */
   data->states[idx++] = D3DCMP_ALWAYS;         /* ALPHAFUNC */
   data->states[idx++] = FALSE;                 /* DITHERENABLE */
   data->states[idx++] = FALSE;                 /* ALPHABLENDENABLE */
   data->states[idx++] = FALSE;                 /* FOGENABLE */
   data->states[idx++] = FALSE;                 /* SPECULARENABLE */
   data->states[idx++] = 0;                     /* FOGCOLOR */
   data->states[idx++] = D3DFOG_NONE;           /* FOGTABLEMODE */
   data->states[idx++] = to_dword(0.0f);        /* FOGSTART */
   data->states[idx++] = to_dword(1.0f);        /* FOGEND */
   data->states[idx++] = to_dword(1.0f);        /* FOGDENSITY */
   data->states[idx++] = FALSE;                 /* RANGEFOGENABLE */
   data->states[idx++] = FALSE;                 /* STENCILENABLE */
   data->states[idx++] = D3DSTENCILOP_KEEP;     /* STENCILFAIL */
   data->states[idx++] = D3DSTENCILOP_KEEP;     /* STENCILZFAIL */
   data->states[idx++] = D3DSTENCILOP_KEEP;     /* STENCILPASS */
   data->states[idx++] = D3DCMP_ALWAYS;         /* STENCILFUNC */
   data->states[idx++] = 0;                     /* STENCILREF */
   data->states[idx++] = 0xFFFFFFFF;            /* STENCILMASK */
   data->states[idx++] = 0xFFFFFFFF;            /* STENCILWRITEMASK */
   data->states[idx++] = 0xFFFFFFFF;            /* TEXTUREFACTOR */
   data->states[idx++] = 0;                     /* WRAP 0 */
   data->states[idx++] = 0;                     /* WRAP 1 */
   data->states[idx++] = 0;                     /* WRAP 2 */
   data->states[idx++] = 0;                     /* WRAP 3 */
   data->states[idx++] = 0;                     /* WRAP 4 */
   data->states[idx++] = 0;                     /* WRAP 5 */
   data->states[idx++] = 0;                     /* WRAP 6 */
   data->states[idx++] = 0;                     /* WRAP 7 */
   data->states[idx++] = TRUE;                  /* CLIPPING */
   data->states[idx++] = TRUE;                  /* LIGHTING */
   data->states[idx++] = 0;                     /* AMBIENT */
   data->states[idx++] = D3DFOG_NONE;           /* FOGVERTEXMODE */
   data->states[idx++] = TRUE;                  /* COLORVERTEX */
   data->states[idx++] = TRUE;                  /* LOCALVIEWER */
   data->states[idx++] = FALSE;                 /* NORMALIZENORMALS */
   data->states[idx++] = D3DMCS_COLOR1;         /* DIFFUSEMATERIALSOURCE */
   data->states[idx++] = D3DMCS_COLOR2;         /* SPECULARMATERIALSOURCE */
   data->states[idx++] = D3DMCS_MATERIAL;       /* AMBIENTMATERIALSOURCE */
   data->states[idx++] = D3DMCS_MATERIAL;       /* EMISSIVEMATERIALSOURCE */
   data->states[idx++] = D3DVBF_DISABLE;        /* VERTEXBLEND */
   data->states[idx++] = 0;                     /* CLIPPLANEENABLE */
#if 0 /* Driver dependent, increase array size to enable */
   data->states[idx++] = to_dword(1.0f);       /* POINTSIZE */
#endif
   data->states[idx++] = to_dword(1.0f);        /* POINTSIZEMIN */
   data->states[idx++] = FALSE;                 /* POINTSPRITEENABLE */
   data->states[idx++] = FALSE;                 /* POINTSCALEENABLE */
   data->states[idx++] = to_dword(1.0f);        /* POINTSCALE_A */
   data->states[idx++] = to_dword(0.0f);        /* POINTSCALE_B */
   data->states[idx++] = to_dword(0.0f);        /* POINTSCALE_C */
   data->states[idx++] = TRUE;                  /* MULTISAMPLEANTIALIAS */
   data->states[idx++] = 0xFFFFFFFF;            /* MULTISAMPLEMASK */
   data->states[idx++] = D3DPATCHEDGE_DISCRETE; /* PATCHEDGESTYLE */
   if (0) data->states[idx++] = 0xbaadcafe;     /* DEBUGMONITORTOKEN, not recorded in the stateblock */
   data->states[idx++] = to_dword(rsarg->pointsize_max); /* POINTSIZE_MAX */
   data->states[idx++] = FALSE;                 /* INDEXEDVERTEXBLENDENABLE */
   data->states[idx++] = 0x0000000F;            /* COLORWRITEENABLE */
   data->states[idx++] = to_dword(0.0f);        /* TWEENFACTOR */
   data->states[idx++] = D3DBLENDOP_ADD;        /* BLENDOP */
   data->states[idx++] = D3DDEGREE_CUBIC;       /* POSITIONDEGREE */
   data->states[idx++] = D3DDEGREE_LINEAR;      /* NORMALDEGREE */
   data->states[idx++] = FALSE;                 /* SCISSORTESTENABLE */
   data->states[idx++] = to_dword(0.0f);        /* SLOPESCALEDEPTHBIAS */
   data->states[idx++] = FALSE;                 /* ANTIALIASEDLINEENABLE */
   data->states[idx++] = to_dword(1.0f);        /* MINTESSELATIONLEVEL */
   data->states[idx++] = to_dword(1.0f);        /* MAXTESSELATIONLEVEL */
   data->states[idx++] = to_dword(0.0f);        /* ADAPTIVETESS_X */
   data->states[idx++] = to_dword(0.0f);        /* ADAPTIVETESS_Y */
   data->states[idx++] = to_dword(1.0f);        /* ADAPTIVETESS_Z */
   data->states[idx++] = to_dword(0.0f);        /* ADAPTIVETESS_W */
   data->states[idx++] = FALSE;                 /* ENABLEADAPTIVETESSELATION */
   data->states[idx++] = FALSE;                 /* TWOSIDEDSTENCILMODE */
   data->states[idx++] = D3DSTENCILOP_KEEP;     /* CCW_STENCILFAIL */
   data->states[idx++] = D3DSTENCILOP_KEEP;     /* CCW_STENCILZFAIL */
   data->states[idx++] = D3DSTENCILOP_KEEP;     /* CCW_STENCILPASS */
   data->states[idx++] = D3DCMP_ALWAYS;         /* CCW_STENCILFUNC */
   data->states[idx++] = 0x0000000F;            /* COLORWRITEENABLE1 */
   data->states[idx++] = 0x0000000F;            /* COLORWRITEENABLE2 */
   data->states[idx++] = 0x0000000F;            /* COLORWRITEENABLE3 */
   data->states[idx++] = 0xFFFFFFFF;            /* BLENDFACTOR */
   data->states[idx++] = 0;                     /* SRGBWRITEENABLE */
   data->states[idx++] = to_dword(0.0f);        /* DEPTHBIAS */
   data->states[idx++] = 0;                     /* WRAP8 */
   data->states[idx++] = 0;                     /* WRAP9 */
   data->states[idx++] = 0;                     /* WRAP10 */
   data->states[idx++] = 0;                     /* WRAP11 */
   data->states[idx++] = 0;                     /* WRAP12 */
   data->states[idx++] = 0;                     /* WRAP13 */
   data->states[idx++] = 0;                     /* WRAP14 */
   data->states[idx++] = 0;                     /* WRAP15 */
   data->states[idx++] = FALSE;                 /* SEPARATEALPHABLENDENABLE */
   data->states[idx++] = D3DBLEND_ONE;          /* SRCBLENDALPHA */
   data->states[idx++] = D3DBLEND_ZERO;         /* DESTBLENDALPHA */
   data->states[idx++] = TRUE;                  /* BLENDOPALPHA */
}

static void render_state_poison_data_init(struct render_state_data *data)
{
    unsigned int i;

    for (i = 0; i < ARRAY_SIZE(render_state_indices); ++i)
    {
       data->states[i] = 0x1337c0de;
    }
}

static void render_state_test_data_init(struct render_state_data *data)
{
   unsigned int idx = 0;
   data->states[idx++] = D3DZB_USEW;            /* ZENABLE */
   data->states[idx++] = D3DFILL_WIREFRAME;     /* FILLMODE */
   data->states[idx++] = D3DSHADE_PHONG;        /* SHADEMODE */
   data->states[idx++] = FALSE;                 /* ZWRITEENABLE */
   data->states[idx++] = TRUE;                  /* ALPHATESTENABLE */
   data->states[idx++] = FALSE;                 /* LASTPIXEL */
   data->states[idx++] = D3DBLEND_SRCALPHASAT;  /* SRCBLEND */
   data->states[idx++] = D3DBLEND_INVDESTALPHA; /* DESTBLEND */
   data->states[idx++] = D3DCULL_CW;            /* CULLMODE */
   data->states[idx++] = D3DCMP_NOTEQUAL;       /* ZFUNC */
   data->states[idx++] = 10;                    /* ALPHAREF */
   data->states[idx++] = D3DCMP_GREATER;        /* ALPHAFUNC */
   data->states[idx++] = TRUE;                  /* DITHERENABLE */
   data->states[idx++] = TRUE;                  /* ALPHABLENDENABLE */
   data->states[idx++] = TRUE;                  /* FOGENABLE */
   data->states[idx++] = TRUE;                  /* SPECULARENABLE */
   data->states[idx++] = 1u << 31;              /* FOGCOLOR */
   data->states[idx++] = D3DFOG_EXP;            /* FOGTABLEMODE */
   data->states[idx++] = to_dword(0.1f);        /* FOGSTART */
   data->states[idx++] = to_dword(0.8f);        /* FOGEND */
   data->states[idx++] = to_dword(0.5f);        /* FOGDENSITY */
   data->states[idx++] = TRUE;                  /* RANGEFOGENABLE */
   data->states[idx++] = TRUE;                  /* STENCILENABLE */
   data->states[idx++] = D3DSTENCILOP_INCRSAT;  /* STENCILFAIL */
   data->states[idx++] = D3DSTENCILOP_REPLACE;  /* STENCILZFAIL */
   data->states[idx++] = D3DSTENCILOP_INVERT;   /* STENCILPASS */
   data->states[idx++] = D3DCMP_LESS;           /* STENCILFUNC */
   data->states[idx++] = 10;                    /* STENCILREF */
   data->states[idx++] = 0xFF00FF00;            /* STENCILMASK */
   data->states[idx++] = 0x00FF00FF;            /* STENCILWRITEMASK */
   data->states[idx++] = 0xF0F0F0F0;            /* TEXTUREFACTOR */
   data->states[idx++] = D3DWRAPCOORD_0 | D3DWRAPCOORD_2;                                   /* WRAP 0 */
   data->states[idx++] = D3DWRAPCOORD_1 | D3DWRAPCOORD_3;                                   /* WRAP 1 */
   data->states[idx++] = D3DWRAPCOORD_2 | D3DWRAPCOORD_3;                                   /* WRAP 2 */
   data->states[idx++] = D3DWRAPCOORD_3 | D3DWRAPCOORD_0;                                   /* WRAP 4 */
   data->states[idx++] = D3DWRAPCOORD_0 | D3DWRAPCOORD_1 | D3DWRAPCOORD_2;                  /* WRAP 5 */
   data->states[idx++] = D3DWRAPCOORD_1 | D3DWRAPCOORD_3 | D3DWRAPCOORD_2;                  /* WRAP 6 */
   data->states[idx++] = D3DWRAPCOORD_2 | D3DWRAPCOORD_1 | D3DWRAPCOORD_0;                  /* WRAP 7 */
   data->states[idx++] = D3DWRAPCOORD_1 | D3DWRAPCOORD_0 | D3DWRAPCOORD_2 | D3DWRAPCOORD_3; /* WRAP 8 */
   data->states[idx++] = FALSE;                 /* CLIPPING */
   data->states[idx++] = FALSE;                 /* LIGHTING */
   data->states[idx++] = 255 << 16;             /* AMBIENT */
   data->states[idx++] = D3DFOG_EXP2;           /* FOGVERTEXMODE */
   data->states[idx++] = FALSE;                 /* COLORVERTEX */
   data->states[idx++] = FALSE;                 /* LOCALVIEWER */
   data->states[idx++] = TRUE;                  /* NORMALIZENORMALS */
   data->states[idx++] = D3DMCS_COLOR2;         /* DIFFUSEMATERIALSOURCE */
   data->states[idx++] = D3DMCS_MATERIAL;       /* SPECULARMATERIALSOURCE */
   data->states[idx++] = D3DMCS_COLOR1;         /* AMBIENTMATERIALSOURCE */
   data->states[idx++] = D3DMCS_COLOR2;         /* EMISSIVEMATERIALSOURCE */
   data->states[idx++] = D3DVBF_3WEIGHTS;       /* VERTEXBLEND */
   data->states[idx++] = 0xf1f1f1f1;            /* CLIPPLANEENABLE */
#if 0 /* Driver dependent, increase array size to enable */
   data->states[idx++] = to_dword(32.0f);       /* POINTSIZE */
#endif
   data->states[idx++] = to_dword(0.7f);        /* POINTSIZEMIN */
   data->states[idx++] = TRUE;                  /* POINTSPRITEENABLE */
   data->states[idx++] = TRUE;                  /* POINTSCALEENABLE */
   data->states[idx++] = to_dword(0.7f);        /* POINTSCALE_A */
   data->states[idx++] = to_dword(0.5f);        /* POINTSCALE_B */
   data->states[idx++] = to_dword(0.4f);        /* POINTSCALE_C */
   data->states[idx++] = FALSE;                 /* MULTISAMPLEANTIALIAS */
   data->states[idx++] = 0xABCDDBCA;            /* MULTISAMPLEMASK */
   data->states[idx++] = D3DPATCHEDGE_CONTINUOUS; /* PATCHEDGESTYLE */
   if (0) data->states[idx++] = D3DDMT_DISABLE; /* DEBUGMONITORTOKEN, not recorded in the stateblock */
   data->states[idx++] = to_dword(77.0f);       /* POINTSIZE_MAX */
   data->states[idx++] = TRUE;                  /* INDEXEDVERTEXBLENDENABLE */
   data->states[idx++] = 0x00000009;            /* COLORWRITEENABLE */
   data->states[idx++] = to_dword(0.2f);        /* TWEENFACTOR */
   data->states[idx++] = D3DBLENDOP_REVSUBTRACT;/* BLENDOP */
   data->states[idx++] = D3DDEGREE_LINEAR;      /* POSITIONDEGREE */
   data->states[idx++] = D3DDEGREE_CUBIC;       /* NORMALDEGREE */
   data->states[idx++] = TRUE;                  /* SCISSORTESTENABLE */
   data->states[idx++] = to_dword(0.33f);       /* SLOPESCALEDEPTHBIAS */
   data->states[idx++] = TRUE;                  /* ANTIALIASEDLINEENABLE */
   data->states[idx++] = to_dword(0.8f);        /* MINTESSELATIONLEVEL */
   data->states[idx++] = to_dword(0.8f);        /* MAXTESSELATIONLEVEL */
   data->states[idx++] = to_dword(0.2f);        /* ADAPTIVETESS_X */
   data->states[idx++] = to_dword(0.3f);        /* ADAPTIVETESS_Y */
   data->states[idx++] = to_dword(0.6f);        /* ADAPTIVETESS_Z */
   data->states[idx++] = to_dword(0.4f);        /* ADAPTIVETESS_W */
   data->states[idx++] = TRUE;                  /* ENABLEADAPTIVETESSELATION */
   data->states[idx++] = TRUE;                  /* TWOSIDEDSTENCILMODE */
   data->states[idx++] = D3DSTENCILOP_ZERO;     /* CCW_STENCILFAIL */
   data->states[idx++] = D3DSTENCILOP_DECR;     /* CCW_STENCILZFAIL */
   data->states[idx++] = D3DSTENCILOP_INCR;     /* CCW_STENCILPASS */
   data->states[idx++] = D3DCMP_ALWAYS;         /* CCW_STENCILFUNC */
   data->states[idx++] = 0x00000007;            /* COLORWRITEENABLE1 */
   data->states[idx++] = 0x00000008;            /* COLORWRITEENABLE2 */
   data->states[idx++] = 0x00000004;            /* COLORWRITEENABLE3 */
   data->states[idx++] = 0xF0F1F2F3;            /* BLENDFACTOR */
   data->states[idx++] = 1;                     /* SRGBWRITEENABLE */
   data->states[idx++] = to_dword(0.3f);        /* DEPTHBIAS */
   data->states[idx++] = D3DWRAPCOORD_0 | D3DWRAPCOORD_2;                                   /* WRAP 8 */
   data->states[idx++] = D3DWRAPCOORD_1 | D3DWRAPCOORD_3;                                   /* WRAP 9 */
   data->states[idx++] = D3DWRAPCOORD_2 | D3DWRAPCOORD_3;                                   /* WRAP 10 */
   data->states[idx++] = D3DWRAPCOORD_3 | D3DWRAPCOORD_0;                                   /* WRAP 11 */
   data->states[idx++] = D3DWRAPCOORD_0 | D3DWRAPCOORD_1 | D3DWRAPCOORD_2;                  /* WRAP 12 */
   data->states[idx++] = D3DWRAPCOORD_1 | D3DWRAPCOORD_3 | D3DWRAPCOORD_2;                  /* WRAP 13 */
   data->states[idx++] = D3DWRAPCOORD_2 | D3DWRAPCOORD_1 | D3DWRAPCOORD_0;                  /* WRAP 14 */
   data->states[idx++] = D3DWRAPCOORD_1 | D3DWRAPCOORD_0 | D3DWRAPCOORD_2 | D3DWRAPCOORD_3; /* WRAP 15 */
   data->states[idx++] = TRUE;                  /* SEPARATEALPHABLENDENABLE */
   data->states[idx++] = D3DBLEND_ZERO;         /* SRCBLENDALPHA */
   data->states[idx++] = D3DBLEND_ONE;          /* DESTBLENDALPHA */
   data->states[idx++] = FALSE;                 /* BLENDOPALPHA */
}

static HRESULT render_state_test_init(IDirect3DDevice9 *device, struct state_test *test)
{
    static const DWORD states_vertex[] =
    {
        D3DRS_ADAPTIVETESS_W,
        D3DRS_ADAPTIVETESS_X,
        D3DRS_ADAPTIVETESS_Y,
        D3DRS_ADAPTIVETESS_Z,
        D3DRS_AMBIENT,
        D3DRS_AMBIENTMATERIALSOURCE,
        D3DRS_CLIPPING,
        D3DRS_CLIPPLANEENABLE,
        D3DRS_COLORVERTEX,
        D3DRS_CULLMODE,
        D3DRS_DIFFUSEMATERIALSOURCE,
        D3DRS_EMISSIVEMATERIALSOURCE,
        D3DRS_ENABLEADAPTIVETESSELLATION,
        D3DRS_FOGCOLOR,
        D3DRS_FOGDENSITY,
        D3DRS_FOGENABLE,
        D3DRS_FOGEND,
        D3DRS_FOGSTART,
        D3DRS_FOGTABLEMODE,
        D3DRS_FOGVERTEXMODE,
        D3DRS_INDEXEDVERTEXBLENDENABLE,
        D3DRS_LIGHTING,
        D3DRS_LOCALVIEWER,
        D3DRS_MAXTESSELLATIONLEVEL,
        D3DRS_MINTESSELLATIONLEVEL,
        D3DRS_MULTISAMPLEANTIALIAS,
        D3DRS_MULTISAMPLEMASK,
        D3DRS_NORMALDEGREE,
        D3DRS_NORMALIZENORMALS,
        D3DRS_PATCHEDGESTYLE,
        D3DRS_POINTSCALE_A,
        D3DRS_POINTSCALE_B,
        D3DRS_POINTSCALE_C,
        D3DRS_POINTSCALEENABLE,
        D3DRS_POINTSIZE,
        D3DRS_POINTSIZE_MAX,
        D3DRS_POINTSIZE_MIN,
        D3DRS_POINTSPRITEENABLE,
        D3DRS_POSITIONDEGREE,
        D3DRS_RANGEFOGENABLE,
        D3DRS_SHADEMODE,
        D3DRS_SPECULARENABLE,
        D3DRS_SPECULARMATERIALSOURCE,
        D3DRS_TWEENFACTOR,
        D3DRS_VERTEXBLEND,
    };

    static const DWORD states_pixel[] =
    {
        D3DRS_ALPHABLENDENABLE,
        D3DRS_ALPHAFUNC,
        D3DRS_ALPHAREF,
        D3DRS_ALPHATESTENABLE,
        D3DRS_ANTIALIASEDLINEENABLE,
        D3DRS_BLENDFACTOR,
        D3DRS_BLENDOP,
        D3DRS_BLENDOPALPHA,
        D3DRS_CCW_STENCILFAIL,
        D3DRS_CCW_STENCILPASS,
        D3DRS_CCW_STENCILZFAIL,
        D3DRS_COLORWRITEENABLE,
        D3DRS_COLORWRITEENABLE1,
        D3DRS_COLORWRITEENABLE2,
        D3DRS_COLORWRITEENABLE3,
        D3DRS_DEPTHBIAS,
        D3DRS_DESTBLEND,
        D3DRS_DESTBLENDALPHA,
        D3DRS_DITHERENABLE,
        D3DRS_FILLMODE,
        D3DRS_FOGDENSITY,
        D3DRS_FOGEND,
        D3DRS_FOGSTART,
        D3DRS_LASTPIXEL,
        D3DRS_SCISSORTESTENABLE,
        D3DRS_SEPARATEALPHABLENDENABLE,
        D3DRS_SHADEMODE,
        D3DRS_SLOPESCALEDEPTHBIAS,
        D3DRS_SRCBLEND,
        D3DRS_SRCBLENDALPHA,
        D3DRS_SRGBWRITEENABLE,
        D3DRS_STENCILENABLE,
        D3DRS_STENCILFAIL,
        D3DRS_STENCILFUNC,
        D3DRS_STENCILMASK,
        D3DRS_STENCILPASS,
        D3DRS_STENCILREF,
        D3DRS_STENCILWRITEMASK,
        D3DRS_STENCILZFAIL,
        D3DRS_TEXTUREFACTOR,
        D3DRS_TWOSIDEDSTENCILMODE,
        D3DRS_WRAP0,
        D3DRS_WRAP1,
        D3DRS_WRAP10,
        D3DRS_WRAP11,
        D3DRS_WRAP12,
        D3DRS_WRAP13,
        D3DRS_WRAP14,
        D3DRS_WRAP15,
        D3DRS_WRAP2,
        D3DRS_WRAP3,
        D3DRS_WRAP4,
        D3DRS_WRAP5,
        D3DRS_WRAP6,
        D3DRS_WRAP7,
        D3DRS_WRAP8,
        D3DRS_WRAP9,
        D3DRS_ZENABLE,
        D3DRS_ZFUNC,
        D3DRS_ZWRITEENABLE,
    };

    const struct render_state_arg *rsarg = test->test_arg;
    unsigned int i, j;

    struct render_state_context *ctx = calloc(1, sizeof(*ctx));
    if (ctx == NULL) return E_FAIL;
    test->test_context = ctx;

    test->default_data = &ctx->default_data_buffer;
    test->initial_data = &ctx->default_data_buffer;
    test->test_data_in = &ctx->test_data_all_buffer;
    test->test_data_out_all = &ctx->test_data_all_buffer;
    test->test_data_out_vertex = &ctx->test_data_vertex_buffer;
    test->test_data_out_pixel = &ctx->test_data_pixel_buffer;

    render_state_default_data_init(rsarg, &ctx->default_data_buffer);
    render_state_test_data_init(&ctx->test_data_all_buffer);
    render_state_poison_data_init(&ctx->poison_data_buffer);

    for (i = 0; i < ARRAY_SIZE(render_state_indices); ++i)
    {
        ctx->test_data_vertex_buffer.states[i] = ctx->default_data_buffer.states[i];
        for (j = 0; j < ARRAY_SIZE(states_vertex); ++j)
        {
            if (render_state_indices[i] == states_vertex[j])
            {
                ctx->test_data_vertex_buffer.states[i] = ctx->test_data_all_buffer.states[i];
                break;
            }
        }

        ctx->test_data_pixel_buffer.states[i] = ctx->default_data_buffer.states[i];
        for (j = 0; j < ARRAY_SIZE(states_pixel); ++j)
        {
            if (render_state_indices[i] == states_pixel[j])
            {
                ctx->test_data_pixel_buffer.states[i] = ctx->test_data_all_buffer.states[i];
                break;
            }
        }
    }

    return D3D_OK;
}

static void render_state_test_cleanup(IDirect3DDevice9 *device, struct state_test *test)
{
    free(test->test_context);
}

static void render_states_queue_test(struct state_test *test, const struct render_state_arg *test_arg)
{
    test->init = render_state_test_init;
    test->cleanup = render_state_test_cleanup;
    test->apply_data = render_state_apply_data;
    test->check_data = render_state_check_data;
    test->test_name = "set_get_render_states";
    test->test_arg = test_arg;
}

/* resource tests */

struct resource_test_arg
{
    DWORD vs_version;
    DWORD ps_version;
    UINT stream_count;
    UINT tex_count;
};

struct resource_test_data
{
    IDirect3DVertexDeclaration9 *decl;
    IDirect3DVertexShader9 *vs;
    IDirect3DPixelShader9 *ps;
    IDirect3DIndexBuffer9 *ib;
    IDirect3DVertexBuffer9 **vb;
    unsigned int stream_offset, stream_stride;
    IDirect3DTexture9 **tex;
};

struct resource_test_context
{
    struct resource_test_data default_data;
    struct resource_test_data test_data_all;
    struct resource_test_data test_data_vertex;
    struct resource_test_data test_data_pixel;
    struct resource_test_data poison_data;
};

static void resource_apply_data(IDirect3DDevice9 *device, const struct state_test *test, const void *data)
{
    const struct resource_test_arg *arg = test->test_arg;
    const struct resource_test_data *d = data;
    IDirect3DVertexBuffer9 *temp_vb = NULL;
    unsigned int i;
    HRESULT hr;

    hr = IDirect3DDevice9_SetVertexDeclaration(device, d->decl);
    ok(SUCCEEDED(hr), "SetVertexDeclaration (%p) returned %#lx.\n", d->decl, hr);

    hr = IDirect3DDevice9_SetVertexShader(device, d->vs);
    ok(SUCCEEDED(hr), "SetVertexShader (%p) returned %#lx.\n", d->vs, hr);

    hr = IDirect3DDevice9_SetPixelShader(device, d->ps);
    ok(SUCCEEDED(hr), "SetPixelShader (%p) returned %#lx.\n", d->ps, hr);

    hr = IDirect3DDevice9_SetIndices(device, d->ib);
    ok(SUCCEEDED(hr), "SetIndices (%p) returned %#lx.\n", d->ib, hr);

    for (i = 0; i < arg->stream_count; ++i)
    {
        if (!d->vb[i])
        {
            /* Use a non NULL vertex buffer to really set offset and stride and avoid leftover values. */
            if (!temp_vb)
            {
                hr = IDirect3DDevice9_CreateVertexBuffer(device, 64, D3DUSAGE_DYNAMIC,
                        0, D3DPOOL_DEFAULT, &temp_vb, NULL);
                ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
            }
            hr = IDirect3DDevice9_SetStreamSource(device, i, temp_vb, d->stream_offset, d->stream_stride);
            ok(hr == D3D_OK, "Got unexpected hr %#lx.\n", hr);
        }

        hr = IDirect3DDevice9_SetStreamSource(device, i, d->vb[i], d->stream_offset, d->stream_stride);
        ok(hr == D3D_OK, "Unexpected SetStreamSource result, i %u, vb %p, "
                "stream_offset %u, stream_stride %u), hr %#lx.\n",
                i, d->vb[i], d->stream_offset, d->stream_stride, hr);
    }
    if (temp_vb)
        IDirect3DVertexBuffer9_Release(temp_vb);

    for (i = 0; i < arg->tex_count; ++i)
    {
        hr = IDirect3DDevice9_SetTexture(device, i, (IDirect3DBaseTexture9 *)d->tex[i]);
        ok(SUCCEEDED(hr), "SetTexture (%u, %p) returned %#lx.\n", i, d->tex[i], hr);
    }
}

static void resource_check_data(IDirect3DDevice9 *device, const struct state_test *test,
        const void *expected_data, unsigned int chain_stage, DWORD quirk)
{
    const struct resource_test_context *ctx = test->test_context;
    const struct resource_test_data *poison = &ctx->poison_data;
    const struct resource_test_arg *arg = test->test_arg;
    const struct resource_test_data *d = expected_data;
    unsigned int expected_offset, i, v, w;
    HRESULT hr;
    void *ptr;

    ptr = poison->decl;
    hr = IDirect3DDevice9_GetVertexDeclaration(device, (IDirect3DVertexDeclaration9 **)&ptr);
    ok(SUCCEEDED(hr), "GetVertexDeclaration returned %#lx.\n", hr);
    if (quirk & SB_QUIRK_RECORDED_VDECL_CAPTURE)
    {
        ok(ptr == ctx->test_data_all.decl, "Chain stage %u, expected vertex declaration %p, received %p.\n",
                chain_stage, ctx->test_data_all.decl, ptr);
    }
    else
    {
        ok(ptr == d->decl, "Chain stage %u, expected vertex declaration %p, received %p.\n",
                chain_stage, d->decl, ptr);
    }
    if (SUCCEEDED(hr) && ptr)
    {
        IDirect3DVertexDeclaration9_Release((IDirect3DVertexDeclaration9 *)ptr);
    }

    ptr = poison->vs;
    hr = IDirect3DDevice9_GetVertexShader(device, (IDirect3DVertexShader9 **)&ptr);
    ok(SUCCEEDED(hr), "GetVertexShader returned %#lx.\n", hr);
    ok(ptr == d->vs, "Chain stage %u, expected vertex shader %p, received %p.\n",
            chain_stage, d->vs, ptr);
    if (SUCCEEDED(hr) && ptr)
    {
        IDirect3DVertexShader9_Release((IDirect3DVertexShader9 *)ptr);
    }

    ptr = poison->ps;
    hr = IDirect3DDevice9_GetPixelShader(device, (IDirect3DPixelShader9 **)&ptr);
    ok(SUCCEEDED(hr), "GetPixelShader returned %#lx.\n", hr);
    ok(ptr == d->ps, "Chain stage %u, expected pixel shader %p, received %p.\n",
            chain_stage, d->ps, ptr);
    if (SUCCEEDED(hr) && ptr)
    {
        IDirect3DPixelShader9_Release((IDirect3DPixelShader9 *)ptr);
    }

    ptr = poison->ib;
    hr = IDirect3DDevice9_GetIndices(device, (IDirect3DIndexBuffer9 **)&ptr);
    ok(SUCCEEDED(hr), "GetIndices returned %#lx.\n", hr);
    ok(ptr == d->ib, "Chain stage %u, expected index buffer %p, received %p.\n",
            chain_stage, d->ib, ptr);
    if (SUCCEEDED(hr) && ptr)
    {
        IDirect3DIndexBuffer9_Release((IDirect3DIndexBuffer9 *)ptr);
    }

    expected_offset = quirk & SB_QUIRK_STREAM_OFFSET_NOT_UPDATED ? 0 : d->stream_offset;
    for (i = 0; i < arg->stream_count; ++i)
    {
        ptr = poison->vb[i];
        hr = IDirect3DDevice9_GetStreamSource(device, i, (IDirect3DVertexBuffer9 **)&ptr, &v, &w);
        ok(SUCCEEDED(hr), "GetStreamSource (%u) returned %#lx.\n", i, hr);
        ok(ptr == d->vb[i], "Chain stage %u, stream %u, expected vertex buffer %p, received %p.\n",
                chain_stage, i, d->vb[i], ptr);
        ok(v == expected_offset, "Stream source offset %u, expected %u, stride %u.\n", v, expected_offset, w);
        ok(w == d->stream_stride, "Stream source stride %u, expected %u.\n", w, d->stream_stride);
        if (SUCCEEDED(hr) && ptr)
        {
            IDirect3DIndexBuffer9_Release((IDirect3DVertexBuffer9 *)ptr);
        }
    }

    for (i = 0; i < arg->tex_count; ++i)
    {
        ptr = poison->tex[i];
        hr = IDirect3DDevice9_GetTexture(device, i, (IDirect3DBaseTexture9 **)&ptr);
        ok(SUCCEEDED(hr), "SetTexture (%u) returned %#lx.\n", i, hr);
        ok(ptr == d->tex[i], "Chain stage %u, texture stage %u, expected texture %p, received %p.\n",
                chain_stage, i, d->tex[i], ptr);
        if (SUCCEEDED(hr) && ptr)
        {
            IDirect3DBaseTexture9_Release((IDirect3DBaseTexture9 *)ptr);
        }
    }
}

static void resource_default_data_init(struct resource_test_data *data, const struct resource_test_arg *arg)
{
    unsigned int i;

    data->decl = NULL;
    data->vs = NULL;
    data->ps = NULL;
    data->ib = NULL;
    data->vb = malloc(arg->stream_count * sizeof(*data->vb));
    for (i = 0; i < arg->stream_count; ++i)
    {
        data->vb[i] = NULL;
    }
    data->stream_offset = 0;
    data->stream_stride = 0;
    data->tex = malloc(arg->tex_count * sizeof(*data->tex));
    for (i = 0; i < arg->tex_count; ++i)
    {
        data->tex[i] = NULL;
    }
}

static void resource_test_data_init(IDirect3DDevice9 *device,
        struct resource_test_data *data, const struct resource_test_arg *arg)
{
    static const DWORD vs_code[] =
    {
        0xfffe0101,                                                             /* vs_1_1                       */
        0x0000001f, 0x80000000, 0x900f0000,                                     /* dcl_position0 v0             */
        0x00000009, 0xc0010000, 0x90e40000, 0xa0e40000,                         /* dp4 oPos.x, v0, c0           */
        0x00000009, 0xc0020000, 0x90e40000, 0xa0e40001,                         /* dp4 oPos.y, v0, c1           */
        0x00000009, 0xc0040000, 0x90e40000, 0xa0e40002,                         /* dp4 oPos.z, v0, c2           */
        0x00000009, 0xc0080000, 0x90e40000, 0xa0e40003,                         /* dp4 oPos.w, v0, c3           */
        0x0000ffff,                                                             /* END                          */
    };
    static const DWORD ps_code[] =
    {
        0xffff0101,                                                             /* ps_1_1                       */
        0x00000051, 0xa00f0001, 0x3f800000, 0x00000000, 0x00000000, 0x00000000, /* def c1 = 1.0, 0.0, 0.0, 0.0  */
        0x00000042, 0xb00f0000,                                                 /* tex t0                       */
        0x00000008, 0x800f0000, 0xa0e40001, 0xa0e40000,                         /* dp3 r0, c1, c0               */
        0x00000005, 0x800f0000, 0x90e40000, 0x80e40000,                         /* mul r0, v0, r0               */
        0x00000005, 0x800f0000, 0xb0e40000, 0x80e40000,                         /* mul r0, t0, r0               */
        0x0000ffff,                                                             /* END                          */
    };
    static const D3DVERTEXELEMENT9 decl[] =
    {
        {0, 0, D3DDECLTYPE_FLOAT3, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_POSITION, 0},
        {0, 12, D3DDECLTYPE_D3DCOLOR, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_COLOR, 0},
        D3DDECL_END(),
    };

    unsigned int i;
    HRESULT hr;

    hr = IDirect3DDevice9_CreateVertexDeclaration(device, decl, &data->decl);
    ok(SUCCEEDED(hr), "CreateVertexDeclaration returned %#lx.\n", hr);

    if (arg->vs_version)
    {
        hr = IDirect3DDevice9_CreateVertexShader(device, vs_code, &data->vs);
        ok(SUCCEEDED(hr), "CreateVertexShader returned %#lx.\n", hr);
    }
    else
    {
        data->vs = NULL;
    }

    if (arg->ps_version)
    {
        hr = IDirect3DDevice9_CreatePixelShader(device, ps_code, &data->ps);
        ok(SUCCEEDED(hr), "CreatePixelShader returned %#lx.\n", hr);
    }
    else
    {
        data->ps = NULL;
    }

    hr = IDirect3DDevice9_CreateIndexBuffer(device, 64, D3DUSAGE_DYNAMIC,
            D3DFMT_INDEX32, D3DPOOL_DEFAULT, &data->ib, NULL);
    ok(SUCCEEDED(hr), "CreateIndexBuffer returned %#lx.\n", hr);

    data->vb = malloc(arg->stream_count * sizeof(*data->vb));
    for (i = 0; i < arg->stream_count; ++i)
    {
        hr = IDirect3DDevice9_CreateVertexBuffer(device, 64, D3DUSAGE_DYNAMIC,
                0, D3DPOOL_DEFAULT, &data->vb[i], NULL);
        ok(SUCCEEDED(hr), "CreateVertexBuffer (%u) returned %#lx.\n", i, hr);
    }
    data->stream_offset = 4;
    data->stream_stride = 64;
    data->tex = malloc(arg->tex_count * sizeof(*data->tex));
    for (i = 0; i < arg->tex_count; ++i)
    {
        hr = IDirect3DDevice9_CreateTexture(device, 64, 64, 0, 0,
                D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &data->tex[i], NULL);
        ok(SUCCEEDED(hr), "CreateTexture (%u) returned %#lx.\n", i, hr);
    }
}

static void resource_poison_data_init(struct resource_test_data *data, const struct resource_test_arg *arg)
{
    DWORD_PTR poison = 0xdeadbeef;
    unsigned int i;

    data->decl = (IDirect3DVertexDeclaration9 *)poison++;
    data->vs = (IDirect3DVertexShader9 *)poison++;
    data->ps = (IDirect3DPixelShader9 *)poison++;
    data->ib = (IDirect3DIndexBuffer9 *)poison++;
    data->vb = malloc(arg->stream_count * sizeof(*data->vb));
    for (i = 0; i < arg->stream_count; ++i)
    {
        data->vb[i] = (IDirect3DVertexBuffer9 *)poison++;
    }
    data->stream_offset = 16;
    data->stream_stride = 128;
    data->tex = malloc(arg->tex_count * sizeof(*data->tex));
    for (i = 0; i < arg->tex_count; ++i)
    {
        data->tex[i] = (IDirect3DTexture9 *)poison++;
    }
}

static HRESULT resource_test_init(IDirect3DDevice9 *device, struct state_test *test)
{
    const struct resource_test_arg *arg = test->test_arg;
    struct resource_test_context *ctx;

    ctx = calloc(1, sizeof(*ctx));
    if (!ctx) return E_OUTOFMEMORY;

    test->test_context = ctx;
    test->test_data_in = &ctx->test_data_all;
    test->test_data_out_all = &ctx->test_data_all;
    test->test_data_out_vertex = &ctx->test_data_vertex;
    test->test_data_out_pixel = &ctx->test_data_pixel;
    test->default_data = &ctx->default_data;
    test->initial_data = &ctx->default_data;

    resource_default_data_init(&ctx->default_data, arg);
    resource_test_data_init(device, &ctx->test_data_all, arg);
    resource_default_data_init(&ctx->test_data_vertex, arg);
    resource_default_data_init(&ctx->test_data_pixel, arg);
    resource_poison_data_init(&ctx->poison_data, arg);

    ctx->test_data_vertex.decl = ctx->test_data_all.decl;
    ctx->test_data_vertex.vs = ctx->test_data_all.vs;
    ctx->test_data_pixel.ps = ctx->test_data_all.ps;

    return D3D_OK;
}

static void resource_test_cleanup(IDirect3DDevice9 *device, struct state_test *test)
{
    struct resource_test_context *ctx = test->test_context;
    const struct resource_test_arg *arg = test->test_arg;
    unsigned int i;

    resource_apply_data(device, test, &ctx->default_data);

    IDirect3DVertexDeclaration9_Release(ctx->test_data_all.decl);
    if (ctx->test_data_all.vs) IDirect3DVertexShader9_Release(ctx->test_data_all.vs);
    if (ctx->test_data_all.ps) IDirect3DPixelShader9_Release(ctx->test_data_all.ps);
    IDirect3DIndexBuffer9_Release(ctx->test_data_all.ib);
    for (i = 0; i < arg->stream_count; ++i)
    {
        IDirect3DVertexBuffer9_Release(ctx->test_data_all.vb[i]);
    }

    for (i = 0; i < arg->tex_count; ++i)
    {
        IDirect3DBaseTexture9_Release(ctx->test_data_all.tex[i]);
    }

    free(ctx->default_data.vb);
    free(ctx->default_data.tex);
    free(ctx->test_data_all.vb);
    free(ctx->test_data_all.tex);
    free(ctx->test_data_vertex.vb);
    free(ctx->test_data_vertex.tex);
    free(ctx->test_data_pixel.vb);
    free(ctx->test_data_pixel.tex);
    free(ctx->poison_data.vb);
    free(ctx->poison_data.tex);
    free(ctx);
}

static void resource_test_queue(struct state_test *test, const struct resource_test_arg *test_arg)
{
    test->init = resource_test_init;
    test->cleanup = resource_test_cleanup;
    test->apply_data = resource_apply_data;
    test->check_data = resource_check_data;
    test->test_name = "set_get_resources";
    test->test_arg = test_arg;
}

/* =================== Main state tests function =============================== */

static void test_state_management(void)
{
    struct shader_constant_arg pshader_constant_arg;
    struct shader_constant_arg vshader_constant_arg;
    struct resource_test_arg resource_test_arg;
    struct render_state_arg render_state_arg;
    D3DPRESENT_PARAMETERS present_parameters;
    struct light_arg light_arg;
    IDirect3DDevice9 *device;
    IDirect3D9 *d3d;
    ULONG refcount;
    D3DCAPS9 caps;
    HWND window;
    HRESULT hr;

    /* Test count: 2 for shader constants
                   1 for lights
                   1 for transforms
                   1 for render states
                   1 for resources
     */
    struct state_test tests[6];
    unsigned int tcount = 0;

    window = CreateWindowA("static", "d3d9_test", WS_OVERLAPPEDWINDOW,
            0, 0, 640, 480, NULL, NULL, NULL, NULL);
    if (!(d3d = Direct3DCreate9(D3D_SDK_VERSION)))
    {
        skip("Failed to create a D3D object, skipping tests.\n");
        DestroyWindow(window);
        return;
    }
    memset(&present_parameters, 0, sizeof(present_parameters));
    present_parameters.Windowed = TRUE;
    present_parameters.hDeviceWindow = window;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    if (FAILED(IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, window,
            D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present_parameters, &device)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirect3D9_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice9_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);

    texture_stages = caps.MaxTextureBlendStages;

    /* Zero test memory */
    memset(tests, 0, sizeof(tests));

    if (caps.VertexShaderVersion & 0xffff) {
        vshader_constant_arg.idx = 0;
        vshader_constant_arg.pshader = FALSE;
        shader_constants_queue_test(&tests[tcount], &vshader_constant_arg);
        tcount++;
    }

    if (caps.PixelShaderVersion & 0xffff) {
        pshader_constant_arg.idx = 0;
        pshader_constant_arg.pshader = TRUE;
        shader_constants_queue_test(&tests[tcount], &pshader_constant_arg);
        tcount++;
    }

    light_arg.idx = 0;
    lights_queue_test(&tests[tcount], &light_arg);
    tcount++;

    transform_queue_test(&tests[tcount]);
    tcount++;

    render_state_arg.device_pparams = &present_parameters;
    render_state_arg.pointsize_max = caps.MaxPointSize;
    render_states_queue_test(&tests[tcount], &render_state_arg);
    tcount++;

    resource_test_arg.vs_version = caps.VertexShaderVersion & 0xffff;
    resource_test_arg.ps_version = caps.PixelShaderVersion & 0xffff;
    resource_test_arg.stream_count = caps.MaxStreams;
    resource_test_arg.tex_count = caps.MaxTextureBlendStages;
    resource_test_queue(&tests[tcount], &resource_test_arg);
    tcount++;

    execute_test_chain_all(device, tests, tcount);

    refcount = IDirect3DDevice9_Release(device);
    ok(!refcount, "Device has %lu references left\n", refcount);
    IDirect3D9_Release(d3d);
    DestroyWindow(window);
}

START_TEST(stateblock)
{
    test_state_management();
}
