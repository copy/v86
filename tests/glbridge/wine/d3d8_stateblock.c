/*
 * Copyright 2006 Ivan Gyurdiev
 * Copyright 2005, 2008 Henri Verbeet
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
#include <d3d8.h>
#include "wine/test.h"

static DWORD texture_stages;

/* ============================ State Testing Framework ========================== */

struct state_test
{
    const char *test_name;

    /* The initial data is usually the same
     * as the default data, but a write can have side effects.
     * The initial data is tested first, before any writes take place
     * The default data can be tested after a write */
    const void *initial_data;

    /* The default data is the standard state to compare
     * against, and restore to */
    const void *default_data;

    /* The test data is the experiment data to try
     * in - what we want to write
     * out - what windows will actually write (not necessarily the same)  */
    const void *test_data_in;
    const void *test_data_out_all;
    const void *test_data_out_vertex;
    const void *test_data_out_pixel;

    HRESULT (*init)(IDirect3DDevice8 *device, struct state_test *test);
    void (*cleanup)(IDirect3DDevice8 *device, struct state_test *test);
    void (*apply_data)(IDirect3DDevice8 *device, const struct state_test *test,
            const void *data);
    void (*check_data)(IDirect3DDevice8 *device, const struct state_test *test,
            const void *data_expected, unsigned int chain_stage);

    /* Test arguments */
    const void *test_arg;

    /* Test-specific context data */
    void *test_context;
};

/* See below for explanation of the flags */
#define EVENT_OK    0
#define EVENT_ERROR -1

struct event_data
{
    DWORD stateblock;
    IDirect3DSurface8 *original_render_target;
    IDirect3DSwapChain8 *new_swap_chain;
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
    int (*event_fn)(IDirect3DDevice8 *device, struct event_data *event_data);
    enum stateblock_data check;
    enum stateblock_data apply;
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
static void execute_test_chain(IDirect3DDevice8 *device, struct state_test *test,
        unsigned int ntests, struct event *event, unsigned int nevents, struct event_data *event_data)
{
    unsigned int i, j;

    /* For each queued event */
    for (j = 0; j < nevents; ++j)
    {
        const void *data;

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
                test[i].check_data(device, &test[i], data, j);
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

static int switch_render_target(IDirect3DDevice8* device, struct event_data *event_data)
{
    D3DPRESENT_PARAMETERS present_parameters;
    IDirect3DSwapChain8 *swapchain = NULL;
    IDirect3DSurface8 *backbuffer = NULL;
    D3DDISPLAYMODE d3ddm;
    HRESULT hr;

    /* Parameters for new swapchain */
    IDirect3DDevice8_GetDisplayMode(device, &d3ddm);
    memset(&present_parameters, 0, sizeof(present_parameters));
    present_parameters.Windowed = TRUE;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present_parameters.BackBufferFormat = d3ddm.Format;

    /* Create new swapchain */
    hr = IDirect3DDevice8_CreateAdditionalSwapChain(device, &present_parameters, &swapchain);
    ok(SUCCEEDED(hr), "CreateAdditionalSwapChain returned %#lx.\n", hr);
    if (FAILED(hr)) goto error;

    /* Get its backbuffer */
    hr = IDirect3DSwapChain8_GetBackBuffer(swapchain, 0, D3DBACKBUFFER_TYPE_MONO, &backbuffer);
    ok(SUCCEEDED(hr), "GetBackBuffer returned %#lx.\n", hr);
    if (FAILED(hr)) goto error;

    /* Save the current render target */
    hr = IDirect3DDevice8_GetRenderTarget(device, &event_data->original_render_target);
    ok(SUCCEEDED(hr), "GetRenderTarget returned %#lx.\n", hr);
    if (FAILED(hr)) goto error;

    /* Set the new swapchain's backbuffer as a render target */
    hr = IDirect3DDevice8_SetRenderTarget(device, backbuffer, NULL);
    ok(SUCCEEDED(hr), "SetRenderTarget returned %#lx.\n", hr);
    if (FAILED(hr)) goto error;

    IDirect3DSurface8_Release(backbuffer);
    event_data->new_swap_chain = swapchain;
    return EVENT_OK;

error:
    if (backbuffer) IDirect3DSurface8_Release(backbuffer);
    if (swapchain) IDirect3DSwapChain8_Release(swapchain);
    return EVENT_ERROR;
}

static int revert_render_target(IDirect3DDevice8 *device, struct event_data *event_data)
{
    HRESULT hr;

    /* Reset the old render target */
    hr = IDirect3DDevice8_SetRenderTarget(device, event_data->original_render_target, NULL);
    ok(SUCCEEDED(hr), "SetRenderTarget returned %#lx.\n", hr);
    if (FAILED(hr))
    {
        IDirect3DSurface8_Release(event_data->original_render_target);
        return EVENT_ERROR;
    }

    IDirect3DSurface8_Release(event_data->original_render_target);
    IDirect3DSwapChain8_Release(event_data->new_swap_chain);
    return EVENT_OK;
}

static int create_stateblock_all(IDirect3DDevice8 *device, struct event_data *event_data)
{
    HRESULT hr;

    hr = IDirect3DDevice8_CreateStateBlock(device, D3DSBT_ALL, &event_data->stateblock);
    ok(SUCCEEDED(hr), "CreateStateBlock returned %#lx.\n", hr);
    if (FAILED(hr)) return EVENT_ERROR;
    return EVENT_OK;
}

static int create_stateblock_vertex(IDirect3DDevice8 *device, struct event_data *event_data)
{
    HRESULT hr;

    hr = IDirect3DDevice8_CreateStateBlock(device, D3DSBT_VERTEXSTATE, &event_data->stateblock);
    ok(SUCCEEDED(hr), "CreateStateBlock returned %#lx.\n", hr);
    if (FAILED(hr)) return EVENT_ERROR;
    return EVENT_OK;
}

static int create_stateblock_pixel(IDirect3DDevice8 *device, struct event_data *event_data)
{
    HRESULT hr;

    hr = IDirect3DDevice8_CreateStateBlock(device, D3DSBT_PIXELSTATE, &event_data->stateblock);
    ok(SUCCEEDED(hr), "CreateStateBlock returned %#lx.\n", hr);
    if (FAILED(hr)) return EVENT_ERROR;
    return EVENT_OK;
}

static int begin_stateblock(IDirect3DDevice8 *device, struct event_data *event_data)
{
    HRESULT hr;

    hr = IDirect3DDevice8_BeginStateBlock(device);
    ok(SUCCEEDED(hr), "BeginStateBlock returned %#lx.\n", hr);
    if (FAILED(hr)) return EVENT_ERROR;
    return EVENT_OK;
}

static int end_stateblock(IDirect3DDevice8 *device, struct event_data *event_data)
{
    HRESULT hr;

    hr = IDirect3DDevice8_EndStateBlock(device, &event_data->stateblock);
    ok(SUCCEEDED(hr), "EndStateBlock returned %#lx.\n", hr);
    if (FAILED(hr)) return EVENT_ERROR;
    return EVENT_OK;
}

static int delete_stateblock(IDirect3DDevice8 *device, struct event_data *event_data)
{
    IDirect3DDevice8_DeleteStateBlock(device, event_data->stateblock);
    return EVENT_OK;
}

static int apply_stateblock(IDirect3DDevice8 *device, struct event_data *event_data)
{
    HRESULT hr;

    hr = IDirect3DDevice8_ApplyStateBlock(device, event_data->stateblock);
    ok(SUCCEEDED(hr), "Apply returned %#lx.\n", hr);

    IDirect3DDevice8_DeleteStateBlock(device, event_data->stateblock);
    if (FAILED(hr)) return EVENT_ERROR;
    return EVENT_OK;
}

static int capture_stateblock(IDirect3DDevice8 *device, struct event_data *event_data)
{
    HRESULT hr;

    hr = IDirect3DDevice8_CaptureStateBlock(device, event_data->stateblock);
    ok(SUCCEEDED(hr), "Capture returned %#lx.\n", hr);
    if (FAILED(hr)) return EVENT_ERROR;

    return EVENT_OK;
}

static void execute_test_chain_all(IDirect3DDevice8 *device, struct state_test *test, unsigned int ntests)
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
        {delete_stateblock,         SB_DATA_DEFAULT,        SB_DATA_NONE},
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
        {end_stateblock,            SB_DATA_NONE,           SB_DATA_NONE},
        {capture_stateblock,        SB_DATA_DEFAULT,        SB_DATA_TEST_IN},
        {apply_stateblock,          SB_DATA_DEFAULT,        SB_DATA_NONE},
    };

    struct event create_stateblock_capture_apply_all_events[] =
    {
        {create_stateblock_all,     SB_DATA_DEFAULT,        SB_DATA_TEST_IN},
        {capture_stateblock,        SB_DATA_TEST_ALL,       SB_DATA_DEFAULT},
        {apply_stateblock,          SB_DATA_TEST_ALL,       SB_DATA_NONE},
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
    execute_test_chain(device, test, ntests, read_events, 1, NULL);

    trace("Running write-read state tests\n");
    execute_test_chain(device, test, ntests, write_read_events, 2, NULL);

    trace("Running stateblock abort state tests\n");
    execute_test_chain(device, test, ntests, abort_stateblock_events, 3, &arg);

    trace("Running stateblock apply state tests\n");
    execute_test_chain(device, test, ntests, apply_stateblock_events, 3, &arg);

    trace("Running stateblock capture/reapply state tests\n");
    execute_test_chain(device, test, ntests, capture_reapply_stateblock_events, 4, &arg);

    trace("Running create stateblock capture/apply all state tests\n");
    execute_test_chain(device, test, ntests, create_stateblock_capture_apply_all_events, 3, &arg);

    trace("Running create stateblock apply all state tests\n");
    execute_test_chain(device, test, ntests, create_stateblock_apply_all_events, 3, &arg);

    trace("Running create stateblock capture/apply vertex state tests\n");
    execute_test_chain(device, test, ntests, create_stateblock_capture_apply_vertex_events, 3, &arg);

    trace("Running create stateblock apply vertex state tests\n");
    execute_test_chain(device, test, ntests, create_stateblock_apply_vertex_events, 3, &arg);

    trace("Running create stateblock capture/apply pixel state tests\n");
    execute_test_chain(device, test, ntests, create_stateblock_capture_apply_pixel_events, 3, &arg);

    trace("Running create stateblock apply pixel state tests\n");
    execute_test_chain(device, test, ntests, create_stateblock_apply_pixel_events, 3, &arg);

    trace("Running rendertarget switch state tests\n");
    execute_test_chain(device, test, ntests, rendertarget_switch_events, 3, &arg);

    trace("Running stateblock apply over rendertarget switch interrupt tests\n");
    execute_test_chain(device, test, ntests, rendertarget_stateblock_events, 5, &arg);

    /* Cleanup resources */
    for (i = 0; i < ntests; ++i)
    {
        if (test[i].cleanup) test[i].cleanup(device, &test[i]);
    }
}

/* =================== State test: Pixel and Vertex Shader constants ============ */

struct shader_constant_data
{
    float float_constant[4]; /* 1x4 float constant */
};

struct shader_constant_arg
{
    unsigned int idx;
    BOOL pshader;
};

static const struct shader_constant_data shader_constant_poison_data =
{
    {1.0f, 2.0f, 3.0f, 4.0f},
};

static const struct shader_constant_data shader_constant_default_data =
{
    {0.0f, 0.0f, 0.0f, 0.0f},
};

static const struct shader_constant_data shader_constant_test_data =
{
    {5.0f, 6.0f, 7.0f, 8.0f},
};

static void shader_constant_apply_data(IDirect3DDevice8 *device, const struct state_test *test, const void *data)
{
    const struct shader_constant_data *scdata = data;
    const struct shader_constant_arg *scarg = test->test_arg;
    unsigned int index = scarg->idx;
    HRESULT hr;

    if (!scarg->pshader)
    {
        hr = IDirect3DDevice8_SetVertexShaderConstant(device, index, scdata->float_constant, 1);
        ok(SUCCEEDED(hr), "SetVertexShaderConstant returned %#lx.\n", hr);
    }
    else
    {
        hr = IDirect3DDevice8_SetPixelShaderConstant(device, index, scdata->float_constant, 1);
        ok(SUCCEEDED(hr), "SetPixelShaderConstant returned %#lx.\n", hr);
    }
}

static void shader_constant_check_data(IDirect3DDevice8 *device, const struct state_test *test,
        const void *expected_data, unsigned int chain_stage)
{
    const struct shader_constant_data *scdata = expected_data;
    const struct shader_constant_arg *scarg = test->test_arg;
    struct shader_constant_data value;
    HRESULT hr;

    value = shader_constant_poison_data;

    if (!scarg->pshader)
    {
        hr = IDirect3DDevice8_GetVertexShaderConstant(device, scarg->idx, value.float_constant, 1);
        ok(SUCCEEDED(hr), "GetVertexShaderConstant returned %#lx.\n", hr);
    }
    else
    {
        hr = IDirect3DDevice8_GetPixelShaderConstant(device, scarg->idx, value.float_constant, 1);
        ok(SUCCEEDED(hr), "GetPixelShaderConstant returned %#lx.\n", hr);
    }

    ok(!memcmp(value.float_constant, scdata->float_constant, sizeof(scdata->float_constant)),
            "Chain stage %u, %s constant:\n\t{%.8e, %.8e, %.8e, %.8e} expected\n\t{%.8e, %.8e, %.8e, %.8e} received\n",
            chain_stage, scarg->pshader ? "pixel shader" : "vertex shader",
            scdata->float_constant[0], scdata->float_constant[1],
            scdata->float_constant[2], scdata->float_constant[3],
            value.float_constant[0], value.float_constant[1],
            value.float_constant[2], value.float_constant[3]);
}

static HRESULT shader_constant_test_init(IDirect3DDevice8 *device, struct state_test *test)
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
    D3DLIGHT8 light;
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
        {7.0, 4.0, 2.0, 1.0},
        {7.0, 4.0, 2.0, 1.0},
        {7.0, 4.0, 2.0, 1.0},
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
        {1.0, 1.0, 1.0, 0.0},
        {0.0, 0.0, 0.0, 0.0},
        {0.0, 0.0, 0.0, 0.0},
        {0.0, 0.0, 0.0},
        {0.0, 0.0, 1.0},
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    },
    FALSE,
    D3D_OK,
    D3D_OK,
};

/* This is used for the initial read state (before a write causes side effects)
 * The proper return status is D3DERR_INVALIDCALL */
static const struct light_data light_initial_data =
{
    {
        0x1337c0de,
        {7.0, 4.0, 2.0, 1.0},
        {7.0, 4.0, 2.0, 1.0},
        {7.0, 4.0, 2.0, 1.0},
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
        {2.0, 2.0, 2.0, 2.0},
        {3.0, 3.0, 3.0, 3.0},
        {4.0, 4.0, 4.0, 4.0},
        {5.0, 5.0, 5.0},
        {6.0, 6.0, 6.0},
        7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0,
    },
    TRUE,
    D3D_OK,
    D3D_OK,
};

/* SetLight will use 128 as the "enabled" value */
static const struct light_data light_test_data_out =
{
    {
        1,
        {2.0, 2.0, 2.0, 2.0},
        {3.0, 3.0, 3.0, 3.0},
        {4.0, 4.0, 4.0, 4.0},
        {5.0, 5.0, 5.0},
        {6.0, 6.0, 6.0},
        7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0,
    },
    128,
    D3D_OK,
    D3D_OK,
};

static void light_apply_data(IDirect3DDevice8 *device, const struct state_test *test, const void *data)
{
    const struct light_data *ldata = data;
    const struct light_arg *larg = test->test_arg;
    unsigned int index = larg->idx;
    HRESULT hr;

    hr = IDirect3DDevice8_SetLight(device, index, &ldata->light);
    ok(SUCCEEDED(hr), "SetLight returned %#lx.\n", hr);

    hr = IDirect3DDevice8_LightEnable(device, index, ldata->enabled);
    ok(SUCCEEDED(hr), "SetLightEnable returned %#lx.\n", hr);
}

static void light_check_data(IDirect3DDevice8 *device, const struct state_test *test,
        const void *expected_data, unsigned int chain_stage)
{
    const struct light_arg *larg = test->test_arg;
    const struct light_data *ldata = expected_data;
    struct light_data value;

    value = light_poison_data;

    value.get_enabled_result = IDirect3DDevice8_GetLightEnable(device, larg->idx, &value.enabled);
    value.get_light_result = IDirect3DDevice8_GetLight(device, larg->idx, &value.light);

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

static HRESULT light_test_init(IDirect3DDevice8 *device, struct state_test *test)
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
        45.0f, 46.0f, 47.0f, 48.0f,
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


static void transform_apply_data(IDirect3DDevice8 *device, const struct state_test *test, const void *data)
{
    const struct transform_data *tdata = data;
    HRESULT hr;

    hr = IDirect3DDevice8_SetTransform(device, D3DTS_VIEW, &tdata->view);
    ok(SUCCEEDED(hr), "SetTransform returned %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTransform(device, D3DTS_PROJECTION, &tdata->projection);
    ok(SUCCEEDED(hr), "SetTransform returned %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTransform(device, D3DTS_TEXTURE0, &tdata->texture0);
    ok(SUCCEEDED(hr), "SetTransform returned %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTransform(device, D3DTS_TEXTURE0 + texture_stages - 1, &tdata->texture7);
    ok(SUCCEEDED(hr), "SetTransform returned %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTransform(device, D3DTS_WORLD, &tdata->world0);
    ok(SUCCEEDED(hr), "SetTransform returned %#lx.\n", hr);

    hr = IDirect3DDevice8_SetTransform(device, D3DTS_WORLDMATRIX(255), &tdata->world255);
    ok(SUCCEEDED(hr), "SetTransform returned %#lx.\n", hr);
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

static void transform_check_data(IDirect3DDevice8 *device, const struct state_test *test,
        const void *expected_data, unsigned int chain_stage)
{
    const struct transform_data *tdata = expected_data;
    D3DMATRIX value;
    HRESULT hr;

    value = transform_poison_data.view;
    hr = IDirect3DDevice8_GetTransform(device, D3DTS_VIEW, &value);
    ok(SUCCEEDED(hr), "GetTransform returned %#lx.\n", hr);
    compare_matrix("View", chain_stage, &value, &tdata->view);

    value = transform_poison_data.projection;
    hr = IDirect3DDevice8_GetTransform(device, D3DTS_PROJECTION, &value);
    ok(SUCCEEDED(hr), "GetTransform returned %#lx.\n", hr);
    compare_matrix("Projection", chain_stage, &value, &tdata->projection);

    value = transform_poison_data.texture0;
    hr = IDirect3DDevice8_GetTransform(device, D3DTS_TEXTURE0, &value);
    ok(SUCCEEDED(hr), "GetTransform returned %#lx.\n", hr);
    compare_matrix("Texture0", chain_stage, &value, &tdata->texture0);

    value = transform_poison_data.texture7;
    hr = IDirect3DDevice8_GetTransform(device, D3DTS_TEXTURE0 + texture_stages - 1, &value);
    ok(SUCCEEDED(hr), "GetTransform returned %#lx.\n", hr);
    compare_matrix("Texture7", chain_stage, &value, &tdata->texture7);

    value = transform_poison_data.world0;
    hr = IDirect3DDevice8_GetTransform(device, D3DTS_WORLD, &value);
    ok(SUCCEEDED(hr), "GetTransform returned %#lx.\n", hr);
    compare_matrix("World0", chain_stage, &value, &tdata->world0);

    value = transform_poison_data.world255;
    hr = IDirect3DDevice8_GetTransform(device, D3DTS_WORLDMATRIX(255), &value);
    ok(SUCCEEDED(hr), "GetTransform returned %#lx.\n", hr);
    compare_matrix("World255", chain_stage, &value, &tdata->world255);
}

static HRESULT transform_test_init(IDirect3DDevice8 *device, struct state_test *test)
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

static void render_state_apply_data(IDirect3DDevice8 *device, const struct state_test *test, const void *data)
{
    const struct render_state_data *rsdata = data;
    unsigned int i;
    HRESULT hr;

    for (i = 0; i < ARRAY_SIZE(render_state_indices); ++i)
    {
        hr = IDirect3DDevice8_SetRenderState(device, render_state_indices[i], rsdata->states[i]);
        ok(SUCCEEDED(hr), "SetRenderState returned %#lx.\n", hr);
    }
}

static void render_state_check_data(IDirect3DDevice8 *device, const struct state_test *test,
        const void *expected_data, unsigned int chain_stage)
{
    const struct render_state_context *ctx = test->test_context;
    const struct render_state_data *rsdata = expected_data;
    unsigned int i;
    HRESULT hr;

    for (i = 0; i < ARRAY_SIZE(render_state_indices); ++i)
    {
        DWORD value = ctx->poison_data_buffer.states[i];
        hr = IDirect3DDevice8_GetRenderState(device, render_state_indices[i], &value);
        ok(SUCCEEDED(hr), "GetRenderState returned %#lx.\n", hr);
        ok(value == rsdata->states[i], "Chain stage %u, render state %#x: expected %#lx, got %#lx.\n",
                chain_stage, render_state_indices[i], rsdata->states[i], value);
    }
}

static inline DWORD to_dword(float fl)
{
    union {float f; DWORD d;} ret;

    ret.f = fl;
    return ret.d;
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
    if (0) data->states[idx++] = to_dword(1.0f); /* POINTSIZE, driver dependent, increase array size to enable */
    data->states[idx++] = to_dword(0.0f);        /* POINTSIZEMIN */
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
    if (0) data->states[idx++] = to_dword(32.0f);/* POINTSIZE, driver dependent, increase array size to enable */
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
}

static HRESULT render_state_test_init(IDirect3DDevice8 *device, struct state_test *test)
{
    static const DWORD states_vertex[] =
    {
        D3DRS_AMBIENT,
        D3DRS_AMBIENTMATERIALSOURCE,
        D3DRS_CLIPPING,
        D3DRS_CLIPPLANEENABLE,
        D3DRS_COLORVERTEX,
        D3DRS_CULLMODE,
        D3DRS_DIFFUSEMATERIALSOURCE,
        D3DRS_EMISSIVEMATERIALSOURCE,
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
        D3DRS_MULTISAMPLEANTIALIAS,
        D3DRS_MULTISAMPLEMASK,
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
        D3DRS_BLENDOP,
        D3DRS_COLORWRITEENABLE,
        D3DRS_DESTBLEND,
        D3DRS_DITHERENABLE,
        D3DRS_FILLMODE,
        D3DRS_FOGDENSITY,
        D3DRS_FOGEND,
        D3DRS_FOGSTART,
        D3DRS_LASTPIXEL,
        D3DRS_SHADEMODE,
        D3DRS_SRCBLEND,
        D3DRS_STENCILENABLE,
        D3DRS_STENCILFAIL,
        D3DRS_STENCILFUNC,
        D3DRS_STENCILMASK,
        D3DRS_STENCILPASS,
        D3DRS_STENCILREF,
        D3DRS_STENCILWRITEMASK,
        D3DRS_STENCILZFAIL,
        D3DRS_TEXTUREFACTOR,
        D3DRS_WRAP0,
        D3DRS_WRAP1,
        D3DRS_WRAP2,
        D3DRS_WRAP3,
        D3DRS_WRAP4,
        D3DRS_WRAP5,
        D3DRS_WRAP6,
        D3DRS_WRAP7,
        D3DRS_ZENABLE,
        D3DRS_ZFUNC,
        D3DRS_ZWRITEENABLE,
    };

    const struct render_state_arg *rsarg = test->test_arg;
    unsigned int i, j;

    struct render_state_context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) return E_FAIL;
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

static void render_state_test_cleanup(IDirect3DDevice8 *device, struct state_test *test)
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
    DWORD vs;
    DWORD ps;
    IDirect3DIndexBuffer8 *ib;
    IDirect3DVertexBuffer8 **vb;
    IDirect3DTexture8 **tex;
};

struct resource_test_context
{
    struct resource_test_data default_data;
    struct resource_test_data test_data_all;
    struct resource_test_data test_data_vertex;
    struct resource_test_data test_data_pixel;
    struct resource_test_data poison_data;
};

static void resource_apply_data(IDirect3DDevice8 *device, const struct state_test *test, const void *data)
{
    const struct resource_test_arg *arg = test->test_arg;
    const struct resource_test_data *d = data;
    unsigned int i;
    HRESULT hr;

    hr = IDirect3DDevice8_SetVertexShader(device, d->vs);
    ok(SUCCEEDED(hr), "SetVertexShader (%lu) returned %#lx.\n", d->vs, hr);

    hr = IDirect3DDevice8_SetPixelShader(device, d->ps);
    ok(SUCCEEDED(hr), "SetPixelShader (%lu) returned %#lx.\n", d->ps, hr);

    hr = IDirect3DDevice8_SetIndices(device, d->ib, 0);
    ok(SUCCEEDED(hr), "SetIndices (%p) returned %#lx.\n", d->ib, hr);

    for (i = 0; i < arg->stream_count; ++i)
    {
        hr = IDirect3DDevice8_SetStreamSource(device, i, d->vb[i], 64);
        ok(SUCCEEDED(hr), "SetStreamSource (%u, %p, 64) returned %#lx.\n",
                i, d->vb[i], hr);
    }

    for (i = 0; i < arg->tex_count; ++i)
    {
        hr = IDirect3DDevice8_SetTexture(device, i, (IDirect3DBaseTexture8 *)d->tex[i]);
        ok(SUCCEEDED(hr), "SetTexture (%u, %p) returned %#lx.\n", i, d->tex[i], hr);
    }
}

static void resource_check_data(IDirect3DDevice8 *device, const struct state_test *test,
        const void *expected_data, unsigned int chain_stage)
{
    const struct resource_test_context *ctx = test->test_context;
    const struct resource_test_data *poison = &ctx->poison_data;
    const struct resource_test_arg *arg = test->test_arg;
    const struct resource_test_data *d = expected_data;
    unsigned int i, base_index;
    HRESULT hr;
    void *ptr;
    DWORD v;

    v = poison->vs;
    hr = IDirect3DDevice8_GetVertexShader(device, &v);
    ok(SUCCEEDED(hr), "GetVertexShader returned %#lx.\n", hr);
    ok(v == d->vs, "Chain stage %u, expected vertex shader %#lx, received %#lx.\n",
            chain_stage, d->vs, v);

    v = poison->ps;
    hr = IDirect3DDevice8_GetPixelShader(device, &v);
    ok(SUCCEEDED(hr), "GetPixelShader returned %#lx.\n", hr);
    ok(v == d->ps, "Chain stage %u, expected pixel shader %#lx, received %#lx.\n",
            chain_stage, d->ps, v);

    ptr = poison->ib;
    hr = IDirect3DDevice8_GetIndices(device, (IDirect3DIndexBuffer8 **)&ptr, &base_index);
    ok(SUCCEEDED(hr), "GetIndices returned %#lx.\n", hr);
    ok(ptr == d->ib, "Chain stage %u, expected index buffer %p, received %p.\n",
            chain_stage, d->ib, ptr);
    if (SUCCEEDED(hr) && ptr)
    {
        IDirect3DIndexBuffer8_Release((IDirect3DIndexBuffer8 *)ptr);
    }

    for (i = 0; i < arg->stream_count; ++i)
    {
        ptr = poison->vb[i];
        hr = IDirect3DDevice8_GetStreamSource(device, i, (IDirect3DVertexBuffer8 **)&ptr, &base_index);
        ok(SUCCEEDED(hr), "GetStreamSource (%u) returned %#lx.\n", i, hr);
        ok(ptr == d->vb[i], "Chain stage %u, stream %u, expected vertex buffer %p, received %p.\n",
                chain_stage, i, d->vb[i], ptr);
        if (SUCCEEDED(hr) && ptr)
        {
            IDirect3DIndexBuffer8_Release((IDirect3DVertexBuffer8 *)ptr);
        }
    }

    for (i = 0; i < arg->tex_count; ++i)
    {
        ptr = poison->tex[i];
        hr = IDirect3DDevice8_GetTexture(device, i, (IDirect3DBaseTexture8 **)&ptr);
        ok(SUCCEEDED(hr), "SetTexture (%u) returned %#lx.\n", i, hr);
        ok(ptr == d->tex[i], "Chain stage %u, texture stage %u, expected texture %p, received %p.\n",
                chain_stage, i, d->tex[i], ptr);
        if (SUCCEEDED(hr) && ptr)
        {
            IDirect3DBaseTexture8_Release((IDirect3DBaseTexture8 *)ptr);
        }
    }
}

static void resource_default_data_init(struct resource_test_data *data, const struct resource_test_arg *arg)
{
    unsigned int i;

    data->vs = 0;
    data->ps = 0;
    data->ib = NULL;
    data->vb = malloc(arg->stream_count * sizeof(*data->vb));
    for (i = 0; i < arg->stream_count; ++i)
    {
        data->vb[i] = NULL;
    }
    data->tex = malloc(arg->tex_count * sizeof(*data->tex));
    for (i = 0; i < arg->tex_count; ++i)
    {
        data->tex[i] = NULL;
    }
}

static void resource_test_data_init(IDirect3DDevice8 *device,
        struct resource_test_data *data, const struct resource_test_arg *arg)
{
    static const DWORD vs_code[] =
    {
        0xfffe0101,                                                             /* vs_1_1                       */
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
    static const DWORD decl[] =
    {
        D3DVSD_STREAM(0),
        D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
        D3DVSD_REG(D3DVSDE_DIFFUSE, D3DVSDT_D3DCOLOR),
        D3DVSD_END(),
    };

    unsigned int i;
    HRESULT hr;

    if (arg->vs_version)
    {
        hr = IDirect3DDevice8_CreateVertexShader(device, decl, vs_code, &data->vs, 0);
        ok(SUCCEEDED(hr), "CreateVertexShader returned hr %#lx.\n", hr);
    }

    if (arg->ps_version)
    {
        hr = IDirect3DDevice8_CreatePixelShader(device, ps_code, &data->ps);
        ok(SUCCEEDED(hr), "CreatePixelShader returned hr %#lx.\n", hr);
    }

    hr = IDirect3DDevice8_CreateIndexBuffer(device, 64, D3DUSAGE_DYNAMIC, D3DFMT_INDEX32, D3DPOOL_DEFAULT, &data->ib);
    ok(SUCCEEDED(hr), "CreateIndexBuffer returned hr %#lx.\n", hr);

    data->vb = malloc(arg->stream_count * sizeof(*data->vb));
    for (i = 0; i < arg->stream_count; ++i)
    {
        hr = IDirect3DDevice8_CreateVertexBuffer(device, 64, D3DUSAGE_DYNAMIC,
                0, D3DPOOL_DEFAULT, &data->vb[i]);
        ok(SUCCEEDED(hr), "CreateVertexBuffer (%u) returned hr %#lx.\n", i, hr);
    }

    data->tex = malloc(arg->tex_count * sizeof(*data->tex));
    for (i = 0; i < arg->tex_count; ++i)
    {
        hr = IDirect3DDevice8_CreateTexture(device, 64, 64, 0, 0,
                D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &data->tex[i]);
        ok(SUCCEEDED(hr), "CreateTexture (%u) returned hr %#lx.\n", i, hr);
    }
}

static void resource_poison_data_init(struct resource_test_data *data, const struct resource_test_arg *arg)
{
    DWORD_PTR poison = 0xdeadbeef;
    unsigned int i;

    data->vs = poison++;
    data->ps = poison++;
    data->ib = (IDirect3DIndexBuffer8 *)poison++;
    data->vb = malloc(arg->stream_count * sizeof(*data->vb));
    for (i = 0; i < arg->stream_count; ++i)
    {
        data->vb[i] = (IDirect3DVertexBuffer8 *)poison++;
    }
    data->tex = malloc(arg->tex_count * sizeof(*data->tex));
    for (i = 0; i < arg->tex_count; ++i)
    {
        data->tex[i] = (IDirect3DTexture8 *)poison++;
    }
}

static HRESULT resource_test_init(IDirect3DDevice8 *device, struct state_test *test)
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

    ctx->test_data_vertex.vs = ctx->test_data_all.vs;
    ctx->test_data_pixel.ps = ctx->test_data_all.ps;

    return D3D_OK;
}

static void resource_test_cleanup(IDirect3DDevice8 *device, struct state_test *test)
{
    struct resource_test_context *ctx = test->test_context;
    const struct resource_test_arg *arg = test->test_arg;
    unsigned int i;
    HRESULT hr;

    resource_apply_data(device, test, &ctx->default_data);

    if (ctx->test_data_all.vs)
    {
        hr = IDirect3DDevice8_DeleteVertexShader(device, ctx->test_data_all.vs);
        ok(SUCCEEDED(hr), "DeleteVertexShader (%lu) returned %#lx.\n", ctx->test_data_all.vs, hr);
    }

    if (ctx->test_data_all.ps)
    {
        hr = IDirect3DDevice8_DeletePixelShader(device, ctx->test_data_all.ps);
        ok(SUCCEEDED(hr), "DeletePixelShader (%lu) returned %#lx.\n", ctx->test_data_all.ps, hr);
    }

    IDirect3DIndexBuffer8_Release(ctx->test_data_all.ib);
    for (i = 0; i < arg->stream_count; ++i)
    {
        IDirect3DVertexBuffer8_Release(ctx->test_data_all.vb[i]);
    }

    for (i = 0; i < arg->tex_count; ++i)
    {
        IDirect3DBaseTexture8_Release(ctx->test_data_all.tex[i]);
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
    IDirect3DDevice8 *device;
    IDirect3D8 *d3d;
    ULONG refcount;
    D3DCAPS8 caps;
    HWND window;
    HRESULT hr;

    /* Test count: 2 for shader constants
     *             1 for lights
     *             1 for transforms
     *             1 for render states
     *             1 for resources
     */
    struct state_test tests[6];
    unsigned int tcount = 0;

    window = CreateWindowA("static", "d3d8_test", WS_OVERLAPPEDWINDOW,
            0, 0, 640, 480, NULL, NULL, NULL, NULL);
    if (!(d3d = Direct3DCreate8(D3D_SDK_VERSION)))
    {
        skip("Failed to create a D3D object, skipping tests.\n");
        DestroyWindow(window);
        return;
    }
    memset(&present_parameters, 0, sizeof(present_parameters));
    present_parameters.Windowed = TRUE;
    present_parameters.hDeviceWindow = window;
    present_parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    present_parameters.BackBufferFormat = D3DFMT_A8R8G8B8;
    if (FAILED(IDirect3D8_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, window,
            D3DCREATE_SOFTWARE_VERTEXPROCESSING, &present_parameters, &device)))
    {
        skip("Failed to create a 3D device, skipping test.\n");
        IDirect3D8_Release(d3d);
        DestroyWindow(window);
        return;
    }

    hr = IDirect3DDevice8_GetDeviceCaps(device, &caps);
    ok(SUCCEEDED(hr), "Failed to get device caps, hr %#lx.\n", hr);

    texture_stages = caps.MaxTextureBlendStages;

    /* Zero test memory */
    memset(tests, 0, sizeof(tests));

    if (caps.VertexShaderVersion & 0xffff)
    {
        vshader_constant_arg.idx = 0;
        vshader_constant_arg.pshader = FALSE;
        shader_constants_queue_test(&tests[tcount++], &vshader_constant_arg);
    }

    if (caps.PixelShaderVersion & 0xffff)
    {
        pshader_constant_arg.idx = 0;
        pshader_constant_arg.pshader = TRUE;
        shader_constants_queue_test(&tests[tcount++], &pshader_constant_arg);
    }

    light_arg.idx = 0;
    lights_queue_test(&tests[tcount++], &light_arg);

    transform_queue_test(&tests[tcount++]);

    render_state_arg.device_pparams = &present_parameters;
    render_state_arg.pointsize_max = caps.MaxPointSize;
    render_states_queue_test(&tests[tcount++], &render_state_arg);

    resource_test_arg.vs_version = caps.VertexShaderVersion & 0xffff;
    resource_test_arg.ps_version = caps.PixelShaderVersion & 0xffff;
    resource_test_arg.stream_count = caps.MaxStreams;
    resource_test_arg.tex_count = caps.MaxTextureBlendStages;
    resource_test_queue(&tests[tcount++], &resource_test_arg);

    execute_test_chain_all(device, tests, tcount);

    refcount = IDirect3DDevice8_Release(device);
    ok(!refcount, "Device has %lu references left.\n", refcount);
    IDirect3D8_Release(d3d);
    DestroyWindow(window);
}

START_TEST(stateblock)
{
    test_state_management();
}
