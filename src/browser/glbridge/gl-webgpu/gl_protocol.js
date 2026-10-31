// The OpenGL protocol, once (docs/opengl-webgpu-plan.md C1): the VGL2 records
// openglproxy's opengl32.dll writes and gl_executor.js reads -- every opcode,
// the control records, the flat argument lists, the fixed headers of the
// hand-written records and the constants both sides use. The guest's
// gl_protocol.h and gl_opcode_names.h are generated from this file
// (tools/gen_gl_protocol_header.mjs), with an assert of every record header's
// size and every field's offset.
//
// A record is u16 opcode, u16 size (0xFFFF: a u32 size follows), then the
// payload. A flat record's payload is its argument list (i = int32, u = uint32,
// f = float32, d = float64); a hand-written record starts with a fixed header
// and carries strings, arrays or pixels after it, decoded by the handler.
(function(global) {
    "use strict";

    // [name, opcode, GL entry point, argument codes] for a flat record,
    // [name, opcode, null, "type:field ..."] for a fixed header, [name, opcode]
    // for a record whose layout only its handler knows yet. A name list
    // (GEN_*, DELETE_*) is its count, then that many u32 names; DRAW_BUFFERS
    // is its count, then the buffers.
    const OPCODES = [
        ["VIEWPORT", 1, "Viewport", "iiii"],
        ["CLEAR_COLOR", 2, "ClearColor", "ffff"],
        ["CLEAR", 3, "Clear", "u"],
        ["BEGIN", 4, "Begin", "u"],
        ["END", 5, "End", ""],
        ["COLOR4F", 6, "Color4f", "ffff"],
        ["VERTEX3F", 7, "Vertex3f", "fff"],
        ["FLUSH", 8, "Flush", ""],
        ["FINISH", 9, "Finish", ""],
        ["MATRIX_MODE", 10, "MatrixMode", "u"],
        ["LOAD_IDENTITY", 11, "LoadIdentity", ""],
        ["FRUSTUM", 12, "Frustum", "dddddd"],
        ["ORTHO", 13, "Ortho", "dddddd"],
        ["TRANSLATEF", 14, "Translatef", "fff"],
        ["ROTATEF", 15, "Rotatef", "ffff"],
        ["SCALEF", 16, "Scalef", "fff"],
        ["PUSH_MATRIX", 17, "PushMatrix", ""],
        ["POP_MATRIX", 18, "PopMatrix", ""],
        ["ENABLE", 19, "Enable", "u"],
        ["DISABLE", 20, "Disable", "u"],
        ["DEPTH_FUNC", 21, "DepthFunc", "u"],
        ["CLEAR_DEPTH", 22, "ClearDepth", "d"],
        ["SHADE_MODEL", 23, "ShadeModel", "u"],
        ["CULL_FACE", 24, "CullFace", "u"],
        ["FRONT_FACE", 25, "FrontFace", "u"],
        ["GEN_TEXTURES", 26, null, "u:count"],
        ["DELETE_TEXTURES", 27, null, "u:count"],
        ["BIND_TEXTURE", 28, "BindTexture", "uu"],
        ["TEX_IMAGE_2D", 29, null, "u:target i:level i:internalformat i:width i:height i:border u:format u:type u:data_size"],
        ["TEX_SUB_IMAGE_2D", 30, null, "u:target i:level i:xoffset i:yoffset i:width i:height u:format u:type u:data_size"],
        ["TEX_PARAMETERI", 31, "TexParameteri", "uui"],
        ["TEX_PARAMETERF", 32, "TexParameterf", "uuf"],
        ["PIXEL_STOREI", 33, "PixelStorei", "ui"],
        ["TEX_ENVI", 34, "TexEnvi", "uui"],
        ["TEX_ENVF", 35, "TexEnvf", "uuf"],
        ["TEX_COORD2F", 36, "TexCoord2f", "ff"],
        ["ENABLE_CLIENT_STATE", 37, "EnableClientState", "u"],
        ["DISABLE_CLIENT_STATE", 38, "DisableClientState", "u"],
        ["DRAW_ARRAYS", 39, null, "u:mode i:count"], // optional MT header, then array blocks
        ["DRAW_ELEMENTS", 40, null, "u:mode i:count u:type u:index_data_size"],
        ["BLEND_FUNC", 41, "BlendFunc", "uu"],
        ["ALPHA_FUNC", 42, "AlphaFunc", "uf"],
        ["DEPTH_MASK", 43, "DepthMask", "u"],
        ["COLOR_MASK", 44, "ColorMask", "uuuu"],
        ["SCISSOR", 45, "Scissor", "iiii"],
        ["LINE_WIDTH", 46, "LineWidth", "f"],
        ["POLYGON_MODE", 47, "PolygonMode", "uu"],
        ["ACTIVE_TEXTURE", 48, "ActiveTexture", "u"],
        ["CLIENT_ACTIVE_TEXTURE", 49, "ClientActiveTexture", "u"],
        ["MULTI_TEX_COORD4F", 50, "MultiTexCoord4f", "uffff"],
        ["NORMAL3F", 51, "Normal3f", "fff"],
        ["FOGF", 52, "Fogf", "uf"],
        ["FOGI", 53, "Fogi", "ui"],
        ["FOGFV", 54, "Fogfv4", "uuffff"],
        ["MATERIALF", 55, "Materialf", "uuf"],
        ["MATERIALI", 56, "Materiali", "uui"],
        ["MATERIALFV", 57, "Materialfv4", "uuuffff"],
        ["MATERIALIV", 58, "Materialiv4", "uuuiiii"],
        ["TEX_ENVIV", 59, "TexEnviv4", "uuuiiii"],
        ["TEX_ENVFV", 60, "TexEnvfv4", "uuuffff"],
        ["LIGHTF", 61, "Lightf", "uuf"],
        ["LIGHTI", 62, "Lighti", "uui"],
        ["LIGHTFV", 63, "Lightfv4", "uuuffff"],
        ["LIGHTIV", 64, "Lightiv4", "uuuiiii"],
        ["LIGHT_MODELF", 65, "LightModelf", "uf"],
        ["LIGHT_MODELI", 66, "LightModeli", "ui"],
        ["LIGHT_MODELFV", 67, "LightModelfv4", "uuffff"],
        ["LIGHT_MODELIV", 68, "LightModeliv4", "uuiiii"],
        ["LOAD_MATRIXF", 69, null, "f:values[16]"],
        ["MULT_MATRIXF", 70, null, "f:values[16]"],
        ["DEPTH_RANGE", 71, "DepthRange", "dd"],
        ["CLEAR_STENCIL", 72, "ClearStencil", "i"],
        ["STENCIL_FUNC", 73, "StencilFunc", "uiu"],
        ["STENCIL_MASK", 74, "StencilMask", "u"],
        ["STENCIL_OP", 75, "StencilOp", "uuu"],
        ["HINT", 76, "Hint", "uu"],
        ["POLYGON_OFFSET", 77, "PolygonOffset", "ff"],
        ["TEX_PARAMETERIV", 78, "TexParameteriv4", "uuuiiii"],
        ["TEX_PARAMETERFV", 79, "TexParameterfv4", "uuuffff"],
        ["TEX_GENI", 80, "TexGeni", "uui"],
        ["TEX_GENF", 81, "TexGenf", "uuf"],
        ["TEX_GENIV", 82, "TexGeniv4", "uuuiiii"],
        ["TEX_GENFV", 83, "TexGenfv4", "uuuffff"],
        ["CLIP_PLANE", 84, "ClipPlane4d", "udddd"],
        ["COLOR_MATERIAL", 85, "ColorMaterial", "uu"],
        ["PUSH_ATTRIB", 86, "PushAttrib", "u"],
        ["POP_ATTRIB", 87, "PopAttrib", ""],
        ["PUSH_CLIENT_ATTRIB", 88, "PushClientAttrib", "u"],
        ["POP_CLIENT_ATTRIB", 89, "PopClientAttrib", ""],
        ["DRAW_BUFFER", 90, "DrawBuffer", "u"],
        ["READ_BUFFER", 91, "ReadBuffer", "u"],
        ["COPY_TEX_IMAGE_2D", 92, "CopyTexImage2D", "uiuiiiii"],
        ["COPY_TEX_SUB_IMAGE_2D", 93, "CopyTexSubImage2D", "uiiiiiii"],
        ["READ_PIXELS", 94, null, "i:x i:y i:width i:height u:format u:type u:data_size u:status"],
        ["BLEND_COLOR", 95, "BlendColor", "ffff"],
        ["BLEND_EQUATION", 96, "BlendEquation", "u"],
        ["BLEND_FUNC_SEPARATE", 97, "BlendFuncSeparate", "uuuu"],
        ["SAMPLE_COVERAGE", 98, "SampleCoverage", "fu"],
        ["GENERATE_MIPMAP", 99, "GenerateMipmap", "u"],
        ["FOG_COORDF", 100, "FogCoordf", "f"],
        ["SECONDARY_COLOR3F", 101, "SecondaryColor3f", "fff"],
        ["POINT_PARAMETERF", 102, "PointParameterf", "uf"],
        ["POINT_PARAMETERFV", 103, "PointParameterfv3", "ufff"],
        ["COMPRESSED_TEX_IMAGE_2D", 104, null, "u:target i:level u:internalformat i:width i:height i:depth i:border u:image_size"],
        ["TEX_IMAGE_3D", 105, null, "u:target i:level i:internalformat i:width i:height i:depth i:border u:format u:type u:data_size"],
        ["TEX_SUB_IMAGE_3D", 106, null, "u:target i:level i:xoffset i:yoffset i:zoffset i:width i:height i:depth u:format u:type u:data_size"],
        ["COMPRESSED_TEX_IMAGE_1D", 107, null, "u:target i:level u:internalformat i:width i:height i:depth i:border u:image_size"],
        ["COMPRESSED_TEX_IMAGE_3D", 108, null, "u:target i:level u:internalformat i:width i:height i:depth i:border u:image_size"],
        ["COMPRESSED_TEX_SUB_IMAGE_1D", 109, null, "u:target i:level i:xoffset i:yoffset i:zoffset i:width i:height i:depth u:format u:image_size"],
        ["COMPRESSED_TEX_SUB_IMAGE_2D", 110, null, "u:target i:level i:xoffset i:yoffset i:zoffset i:width i:height i:depth u:format u:image_size"],
        ["COMPRESSED_TEX_SUB_IMAGE_3D", 111, null, "u:target i:level i:xoffset i:yoffset i:zoffset i:width i:height i:depth u:format u:image_size"],
        ["WINDOW_POS3F", 112, "WindowPos3f", "fff"],
        ["POINT_PARAMETERI", 113, "PointParameteri", "ui"],
        ["POINT_PARAMETERIV", 114, "PointParameteriv3", "uiii"],
        ["POINT_SIZE", 115, "PointSize", "f"],
        ["LINE_STIPPLE", 116, "LineStipple", "iu"],
        ["LOGIC_OP", 117, "LogicOp", "u"],
        ["PIXEL_TRANSFERF", 118, "PixelTransferf", "uf"],
        ["PIXEL_TRANSFERI", 119, "PixelTransferi", "ui"],
        ["PIXEL_ZOOM", 120, "PixelZoom", "ff"],
        ["DRAW_PIXELS", 121, null, "i:width i:height u:format u:type u:data_size"],
        ["BITMAP", 122, null, "i:width i:height f:xorig f:yorig f:xmove f:ymove u:data_size"],
        ["COPY_PIXELS", 123, "CopyPixels", "iiiiu"],
        ["TEX_IMAGE_1D", 124, null, "u:target i:level i:internalformat i:width i:border u:format u:type u:data_size"],
        ["TEX_SUB_IMAGE_1D", 125, null, "u:target i:level i:xoffset i:width u:format u:type u:data_size"],
        ["COPY_TEX_IMAGE_1D", 126, "CopyTexImage1D", "uiuiiii"],
        ["COPY_TEX_SUB_IMAGE_1D", 127, "CopyTexSubImage1D", "uiiiii"],
        ["CLEAR_ACCUM", 128, "ClearAccum", "ffff"],
        ["ACCUM", 129, "Accum", "uf"],
        ["POLYGON_STIPPLE", 130, null, "u:mask[32]"],
        ["PIXEL_MAPFV", 131, null, "u:map i:count"],
        ["PIXEL_MAPUIV", 132, null, "u:map i:count"],
        ["PIXEL_MAPUSV", 133, null, "u:map i:count"],
        ["TEX_COORD4F", 134, "TexCoord4f", "ffff"],
        ["VERTEX4F", 135, "Vertex4f", "ffff"],
        ["RASTER_POS4F", 136, "RasterPos4f", "ffff"],
        ["BLEND_EQUATION_SEPARATE", 137, "BlendEquationSeparate", "uu"],
        ["DRAW_BUFFERS", 138, null, "u:count"],
        ["STENCIL_OP_SEPARATE", 139, "StencilOpSeparate", "uuuu"],
        ["STENCIL_FUNC_SEPARATE", 140, "StencilFuncSeparate", "uuiu"],
        ["STENCIL_MASK_SEPARATE", 141, "StencilMaskSeparate", "uu"],
        ["CREATE_PROGRAM", 142, "CreateProgramMapped", "u"],
        ["CREATE_SHADER", 143, "CreateShaderMapped", "uu"],
        ["DELETE_PROGRAM", 144, "DeleteProgramMapped", "u"],
        ["DELETE_SHADER", 145, "DeleteShaderMapped", "u"],
        ["ATTACH_SHADER", 146, "AttachShaderMapped", "uu"],
        ["DETACH_SHADER", 147, "DetachShaderMapped", "uu"],
        ["SHADER_SOURCE", 148, null, "u:shader u:length"],
        ["COMPILE_SHADER", 149, "CompileShaderMapped", "u"],
        ["LINK_PROGRAM", 150, "LinkProgramMapped", "u"],
        ["USE_PROGRAM", 151, "UseProgramMapped", "u"],
        ["VALIDATE_PROGRAM", 152, "ValidateProgramMapped", "u"],
        ["BIND_ATTRIB_LOCATION", 153, null, "u:program i:location u:name_length"],
        // Retired location-map records: their obsolete payload is ignored.
        ["MAP_UNIFORM_LOCATION", 154, "MapUniformLocation", ""],
        ["MAP_ATTRIB_LOCATION", 155, "MapAttribLocation", ""],
        ["UNIFORM_FV", 156, null, "i:location i:components i:count"],
        ["UNIFORM_IV", 157, null, "i:location i:components i:count"],
        ["UNIFORM_MATRIX_FV", 158, null, "i:location i:dimension i:count u:transpose"],
        ["VERTEX_ATTRIB4F", 159, "VertexAttrib4fMapped", "uffff"],
        ["ENABLE_VERTEX_ATTRIB_ARRAY", 160, "EnableVertexAttribArrayMapped", "u"],
        ["DISABLE_VERTEX_ATTRIB_ARRAY", 161, "DisableVertexAttribArrayMapped", "u"],
        ["DRAW_ARRAYS_GL2", 162, null, "u:mode i:count"],
        ["DRAW_ELEMENTS_GL2", 163, null, "u:mode i:count u:type u:index_data_size"],
        ["UNIFORM_MATRIX_RECT_FV", 164, null, "i:location i:columns i:rows i:count u:transpose"],
        ["GEN_FRAMEBUFFERS", 165, null, "u:count"],
        ["DELETE_FRAMEBUFFERS", 166, null, "u:count"],
        ["BIND_FRAMEBUFFER", 167, "BindFramebufferMapped", "uu"],
        ["FRAMEBUFFER_TEXTURE", 168, "FramebufferTextureMapped", "uuuuii"],
        ["FRAMEBUFFER_RENDERBUFFER", 169, "FramebufferRenderbufferMapped", "uuuu"],
        ["GEN_RENDERBUFFERS", 170, null, "u:count"],
        ["DELETE_RENDERBUFFERS", 171, null, "u:count"],
        ["BIND_RENDERBUFFER", 172, "BindRenderbufferMapped", "uu"],
        ["RENDERBUFFER_STORAGE", 173, "RenderbufferStorageMapped", "uuii"],
        ["QUERY_OBJECT_IV", 174, null, "u:object_kind u:name u:pname u:status i:value u:reserved"],
        ["QUERY_OBJECT_LOG", 175, null, "u:object_kind u:name u:buf_size u:status u:length u:data_size"],
        ["CHECK_FRAMEBUFFER_STATUS", 176, null, "u:target u:status u:result u:reserved"],
        ["QUERY_ACTIVE", 177, null, "u:active_kind u:program u:index u:buf_size u:status u:length i:size u:type u:data_size u:reserved"],
        ["GEN_QUERIES", 178, null, "u:count"],
        ["DELETE_QUERIES", 179, null, "u:count"],
        ["BEGIN_QUERY", 180, "BeginQueryMapped", "uu"],
        ["END_QUERY", 181, "EndQueryMapped", "u"],
        ["GEN_PROGRAMS_ARB", 182, null, "u:count"],
        ["DELETE_PROGRAMS_ARB", 183, null, "u:count"],
        ["BIND_PROGRAM_ARB", 184, "BindProgramARBMapped", "uu"],
        ["PROGRAM_STRING_ARB", 185, null, "u:target u:format i:length u:reserved"],
        ["PROGRAM_PARAMETER_FV_ARB", 186, null, "u:parameter_kind u:target u:index u:count"],
        ["PROGRAM_PARAMETER_DV_ARB", 187, null, "u:parameter_kind u:target u:index u:reserved d:values[4]"],
        ["QUERY_PROGRAM_IV_ARB", 188, null, "u:target u:pname u:status i:value"],
        ["QUERY_PROGRAM_PARAMETER_FV_ARB", 189, null, "u:parameter_kind u:target u:index u:status u:data_size u:reserved"],
        ["QUERY_PROGRAM_PARAMETER_DV_ARB", 190, null, "u:parameter_kind u:target u:index u:status u:data_size u:reserved"],
        ["QUERY_PROGRAM_STRING_ARB", 191, null, "u:target u:pname u:status u:length u:data_size u:reserved"],
        ["QUERY_GL_STRING", 192, null, "u:name u:status u:length u:data_size"],
        ["QUERY_INTEGER", 193, null, "u:pname u:status i:value u:reserved"],
        ["GEN_BUFFERS", 194, null, "u:count"],
        ["DELETE_BUFFERS", 195, null, "u:count"],
        ["BIND_BUFFER", 196, "BindBufferMapped", "uu"],
        ["BUFFER_DATA", 197, null, "u:target i:size u:usage u:data_size"],
        ["BUFFER_SUB_DATA", 198, null, "u:target i:offset i:size u:data_size"],
        ["VERTEX_POINTER_VBO", 199, null, "i:size u:type i:stride u:offset"],
        ["COLOR_POINTER_VBO", 200, null, "i:size u:type i:stride u:offset"],
        ["TEX_COORD_POINTER_VBO", 201, null, "i:size u:type i:stride u:offset"],
        ["NORMAL_POINTER_VBO", 202, null, "i:size u:type i:stride u:offset"],
        ["SECONDARY_COLOR_POINTER_VBO", 203, null, "i:size u:type i:stride u:offset"],
        ["FOG_COORD_POINTER_VBO", 204, null, "i:size u:type i:stride u:offset"],
        ["VERTEX_ATTRIB_POINTER_VBO", 205, null, "u:index i:size u:type u:normalized i:stride u:offset"],
        ["DRAW_ARRAYS_DIRECT", 206, "DrawArraysDirect", "uii"],
        ["DRAW_ELEMENTS_DIRECT", 207, null, "u:mode u:start u:end i:count u:type u:offset"],
        ["DRAW_RANGE_ELEMENTS_DIRECT", 208, null, "u:mode u:start u:end i:count u:type u:offset"],
        ["MULTI_DRAW_ARRAYS_DIRECT", 209, null, "u:mode i:primcount"],
        ["MULTI_DRAW_ELEMENTS_DIRECT", 210, null, "u:mode u:type i:primcount"],
        ["QUERY_ERROR", 211, null, "u:status u:value u:reserved0 u:reserved1"],
        ["QUERY_LOCATION", 212, null, "u:location_kind u:program i:guest_location u:status i:result u:value_type i:value_count u:name_length"],
        ["QUERY_UNIFORM", 213, null, "u:program i:location u:value_kind u:status i:value_count u:data_size u:reserved0 u:reserved1"],
        ["INVALIDATE_PROGRAM_LOCATIONS", 214, "InvalidateProgramLocations", "u"],
        ["COPY_TEX_SUB_IMAGE_3D", 215, "CopyTexSubImage3D", "uiiiiiiii"],
        ["QUERY_OBJECT_BATCH", 216, null, "u:count u:object_kind u:status u:reserved"],
        ["BLIT_FRAMEBUFFER", 217, "BlitFramebuffer", "iiiiiiiiuu"],
        ["EDGE_FLAG", 218, "EdgeFlag", "u"],
        // CPU-side state queries. The data are already converted to the
        // requested GL type, stored as doubles (including exact 32-bit ints).
        ["QUERY_STATE", 219, null, "u:pname u:value_kind u:status u:count u:data_size u:error"],
        ["QUERY_PARAMETER", 220, null, "u:pname u:value_kind u:status u:count u:data_size u:error u:query_kind u:target u:index u:reserved"],
        ["PRIORITIZE_TEXTURES", 221, null, "i:count"], // then count pairs of u32 name, f32 priority
        // A CPU link failure preserves the previously installed executable.
        ["PROGRAM_LINK_FAILED", 222, "ProgramLinkFailed", "u"],
        ["QUERY_BUFFER_DATA", 223, null, "u:target i:offset i:size i:range_size u:status u:data_size u:error u:buffer"],
        ["QUERY_BUFFER_MAP", 224, null, "u:target u:access u:pointer u:status u:error u:reserved"],
        ["QUERY_BUFFER_UNMAP", 225, null, "u:target u:status u:result u:error"],
        ["INDEX_POINTER_VBO", 226, null, "i:size u:type i:stride u:offset"],
        ["EDGE_FLAG_POINTER_VBO", 227, null, "i:size u:type i:stride u:offset"],
        ["QUERY_NAMES", 228, null, "u:object_kind i:count u:status u:error u:data_size u:reserved"],
        ["FRAMEBUFFER_TEXTURE_1D", 229, "FramebufferTexture1DMapped", "uuuuii"],
        ["FRAMEBUFFER_TEXTURE_2D", 230, "FramebufferTexture2DMapped", "uuuuii"],
        ["FRAMEBUFFER_TEXTURE_3D", 231, "FramebufferTexture3DMapped", "uuuuii"],
        ["BIND_FRAMEBUFFER_EXT", 232, "BindFramebufferEXT", "uu"],
        // Metadata reserves a CPU-validated image read; bounded chunks keep
        // large textures independent of the guest DMA arena's size.
        ["QUERY_TEXTURE_IMAGE", 233, null, "u:target i:level u:format u:type u:compressed u:mode u:pointer u:offset u:data_size u:span u:ticket u:status u:error u:width u:height u:depth u:context_id"],
        ["QUERY_POLYGON_STIPPLE", 234, null, "u:mode u:pointer u:status u:error u:row_stride u:start u:row_bytes u:bit_offset u:lsb_first u:pbo u:span u:data_size"],
        ["POLYGON_STIPPLE_BITMAP", 235, null, "u:data_size u:status u:error u:reserved"],
        ["LIST_COMMAND", 236, null, "u:operation u:name u:value"],
        ["QUERY_LIST", 237, null, "u:operation u:name i:range u:status u:error u:result"],
        ["LIST_CALLS", 238, null, "u:count u:data_size"],
        ["QUERY_RENDER_MODE", 239, null, "u:operation i:size u:type u:pointer u:offset u:data_size u:status u:error i:result u:ticket u:total"],
        ["NAME_COMMAND", 240, null, "u:operation u:name f:value"],
        ["RESOLVED_RASTER_STATE", 241, null, "u:valid f:position[4] f:color[4]"],
        ["CAPTURE_VERTICES", 242, null, "u:job u:first u:count u:total"],
        ["CAPTURE_RASTER_VERTEX", 243, null, "u:job u:reserved"],
        ["RESOLVED_RASTER_ALL", 244, null, "u:valid f:position[4] f:color[4] f:secondary[4] f:distance f:fog f:coords[32]"],
        ["MAP_EVALUATOR", 245, null, "u:dimensions u:target i:uorder i:vorder i:ustride i:vstride u:data_size u:reserved d:domain[4]"],
        ["EVALUATOR_GRID", 246, null, "u:dimensions i:un i:vn u:reserved d:domain[4]"],
        ["EVAL_COORD", 247, null, "u:dimensions u:operation d:values[2]"],
        ["EVAL_MESH", 248, null, "u:dimensions u:mode i:indices[4]"],
        ["QUERY_EVALUATOR", 249, null, "u:pname u:value_kind u:status u:count u:data_size u:error u:target u:reserved"],
        ["RESOLVED_EVAL_VERTEX", 250, null, "f:position[4] f:color[4] f:normal[4] f:texcoord[4]"],
        ["RESOLVED_PROGRAM_INTERFACE", 251, null, "u:program u:object_id u:link_generation u:entry_count u:data_size u:initializer_count"],
        ["INDEX_STATE", 252, null, "u:operation u:mask d:value"],
        ["ACTIVE_STENCIL_FACE", 253, "ActiveStencilFaceEXT", "u"],
        ["PROGRAM_LINK_VALIDATION", 254, null, "u:operation u:job u:program u:object_id u:link_generation u:data_size"],
        ["UPLOAD_CHUNK", 255, null, "u:token u:opcode u:total_size u:offset u:data_size"],
        ["IMMEDIATE_VERTEX_BLOCK", 256, null, "u:run_count u:data_size"],
        ["QUERY_ARRAY_LOCK", 257, null, "u:operation i:first i:count u:status u:error"],
    ];

    // Composite records' optional headers and repeated elements. The common
    // prefixes above remain readable in pre-multitexture snapshot journals.
    const COMPOSITES = [
        ["PACKED_DRAW_ARRAYS_MT", "u:mode i:count u:magic u:tex_unit_count u:client_active_texture"],
        ["PACKED_DRAW_ARRAYS_GL2_MT", "u:mode i:count u:magic u:tex_unit_count u:client_active_texture u:generic_attrib_count"],
        ["PACKED_DRAW_ELEMENTS_MT", "u:mode i:count u:type u:index_data_size u:magic u:tex_unit_count u:client_active_texture"],
        ["PACKED_DRAW_ELEMENTS_GL2_MT", "u:mode i:count u:type u:index_data_size u:magic u:tex_unit_count u:client_active_texture u:generic_attrib_count"],
        ["CLIENT_ARRAY_BLOCK", "u:enabled i:size u:type i:stride u:data_size"],
        ["GENERIC_ATTRIB_BLOCK", "u:index u:normalized u:enabled i:size u:type i:stride u:data_size"],
        ["IMMEDIATE_VERTEX_RUN", "u:attribute_bytes u:vertex_count"],
        ["MULTI_DRAW_ARRAYS_ENTRY", "i:first i:count"],
        ["MULTI_DRAW_ELEMENTS_ENTRY", "i:count u:offset"],
        ["QUERY_OBJECT_BATCH_ENTRY", "u:name u:available u:result"],
        ["PROGRAM_INTERFACE_ENTRY", "u:location_kind i:location u:value_type i:value_count u:name_length"],
    ];

    // Control records, outside the GLFN numbering: [name, code, layout]
    const CONTROL = [
        // the context the commands that follow are for, and its window; an
        // older guest's payload may stop short (the fields after read as 0)
        // (format: its window's pixel format, V86GL_FORMAT_*)
        ["MAKE_CURRENT", 0xFFF0, "u:hwnd i:x i:y u:width u:height u:context_id u:share_group u:format u:caps_profile"],
        ["RELEASE_CURRENT", 0xFFF1],
        // one context; with no payload, every context (an older guest's
        // process teardown)
        ["DESTROY_CONTEXT", 0xFFF2, "u:context_id"],
        // What the guest's window manager says about the drawing window: shown,
        // minimised, covered by other windows entirely or in part (the parts
        // that show follow). See windowState() in gl_executor.js.
        ["WINDOW_STATE", 0xFFF3],
    ];
    const CTRL = Object.fromEntries(CONTROL.map(([name, code]) => [name, code]));

    // The constants of the protocol, as the guest header defines them
    // ([name, value, comment]; a string value is written as it is)
    const DEFINES = [
        ["V86GL_CTRL_MAKE_CURRENT", CTRL.MAKE_CURRENT],
        ["V86GL_CTRL_RELEASE_CURRENT", CTRL.RELEASE_CURRENT],
        ["V86GL_CTRL_DESTROY_CONTEXT", CTRL.DESTROY_CONTEXT],
        ["V86GL_CTRL_WINDOW_STATE", CTRL.WINDOW_STATE, "the drawing window as the guest's window manager sees it"],
        ["V86GL_WINDOW_IS_WINDOW", "(1u << 0)", "its flags: D9WGWindowState's (d3d9proxy/d3d9_protocol.h)"],
        ["V86GL_WINDOW_VISIBLE", "(1u << 1)"],
        ["V86GL_WINDOW_ICONIC", "(1u << 2)"],
        ["V86GL_WINDOW_OCCLUDED", "(1u << 6)"],
        ["V86GL_WINDOW_REGION", "(1u << 7)"],
        ["V86GL_FORMAT_SINGLE_BUFFER", "(1u << 0)", "MAKE_CURRENT's format: no back buffer"],
        ["V86GL_FORMAT_SAMPLES_SHIFT", 8, "and the samples per pixel (0 or 1: one) in bits 8-15"],
        ["V86GL_FORMAT_SAMPLES_MASK", 0xFF00],
        ["V86GL_CAPS_PROFILE_UNRESOLVED", 0, "old guests retain the saved capability strings"],
        ["V86GL_CAPS_PROFILE_WINED3D_GL15", 1],
        ["V86GL_CAPS_PROFILE_WINED3D_ARB", 2],
        ["V86GL_CAPS_PROFILE_GL21_NO_FBO", 3],
        ["V86GL_CAPS_PROFILE_GL21_FBO_FFP", 4],
        ["V86GL_CAPS_PROFILE_GL21", 5],
        ["V86GL_EXTENDED_RECORD_SIZE", 0xFFFF, "a record size of this is followed by a u32 size"],
        ["V86GL_MAX_UPLOAD_BYTES", 256 * 1024 * 1024, "bounded CPU assembly of an upload larger than the arena"],
        ["V86GL_IMMEDIATE_BLOCK_BYTES", 64 * 1024],
        // CPU validation replaces only the opcode of a rejected GL record.
        // Keep its size/payload so every inline response retains its address.
        // 0x8eoo: e = GL error - 0x500 (0..6), oo = original opcode (1..255).
        ["V86GL_REJECTED_RECORD_BIT", 0x8000],
        ["V86GL_REJECTED_RECORD_MASK", 0xF800],
        ["V86GL_REJECTED_ERROR_SHIFT", 8],
        ["V86GL_REJECTED_ERROR_MASK", 0x0700],
        ["V86GL_REJECTED_ERROR_BASE", 0x0500],
        ["V86GL_REJECTED_OPCODE_MASK", 0x00FF],
        // Preserve the original eight-bit tags in old journals; new opcodes
        // use 0x9eoo with a nine-bit source opcode and error bits 9-11.
        ["V86GL_MAX_OPCODE", 0x01FF],
        ["V86GL_REJECTED_EXTENDED_BIT", 0x9000],
        ["V86GL_REJECTED_EXTENDED_MASK", 0xF000],
        ["V86GL_REJECTED_EXTENDED_ERROR_SHIFT", 9],
        ["V86GL_REJECTED_EXTENDED_ERROR_MASK", 0x0E00],
        ["V86GL_RESPONSE_REGION_BYTES", 4 * 1024 * 1024],
        ["V86GL_HEARTBEAT_BYTES", 16, "reserved at the end of the arena, outside the GL command stream"],
        ["V86GL_HEARTBEAT_OFFSET", 4 * 1024 * 1024 - 16],
        ["V86GL_ASYNC_HOST_TIMEOUT_MS", 5000],
        ["V86GL_ASYNC_SILENCE_MS", 6000, "longer than the host's own readback deadline"],
        ["V86GL_READ_PIXELS_HEADER_SIZE", 32],
        ["V86GL_READ_PIXELS_STATUS_PENDING", 0],
        ["V86GL_READ_PIXELS_STATUS_OK", 1],
        ["V86GL_READ_PIXELS_STATUS_FAILED", 2],
        ["V86GL_SYNC_QUERY_STATUS_PENDING", 0],
        ["V86GL_SYNC_QUERY_STATUS_OK", 1],
        ["V86GL_SYNC_QUERY_STATUS_FAILED", 2],
        ["V86GL_STATE_QUERY_UNSUPPORTED", 3, "state not migrated to the CPU shadow yet"],
        ["V86GL_STIPPLE_SOURCE_PBO_BIT", 1],
        ["V86GL_STIPPLE_CAPTURE_FAILURE_BIT", 2, "capture-only setter query stored a deferred list error"],
        ["V86GL_STATE_INTEGER", 1],
        ["V86GL_STATE_FLOAT", 2],
        ["V86GL_STATE_DOUBLE", 3],
        ["V86GL_STATE_BOOLEAN", 4],
        ["V86GL_STATE_IS_ENABLED", 5, "glIsEnabled: capability validation and one boolean answer"],
        ["V86GL_STATE_UNSIGNED_SHORT", 6, "pixel map unsigned short output"],
        ["V86GL_STATE_UNSIGNED_INT", 7, "pixel map unsigned integer output"],
        ["V86GL_MAX_TYPED_QUERY_VALUES", 256],
        ["V86GL_MAX_EVAL_ORDER", 8],
        ["V86GL_MAX_EVALUATOR_VALUES", 256],
        ["V86GL_PARAMETER_LIGHT", 1],
        ["V86GL_PARAMETER_MATERIAL", 2],
        ["V86GL_PARAMETER_TEX_ENV", 3],
        ["V86GL_PARAMETER_TEX_GEN", 4],
        ["V86GL_PARAMETER_CLIP_PLANE", 5],
        ["V86GL_PARAMETER_PIXEL_MAP", 6],
        ["V86GL_PARAMETER_IS_OBJECT", 7],
        ["V86GL_PARAMETER_FRAMEBUFFER_ATTACHMENT", 8],
        ["V86GL_PARAMETER_RENDERBUFFER", 9],
        ["V86GL_PARAMETER_TEXTURE", 10],
        ["V86GL_PARAMETER_TEXTURE_LEVEL", 11],
        ["V86GL_PARAMETER_BUFFER", 12],
        ["V86GL_PARAMETER_BUFFER_POINTER", 13],
        ["V86GL_PARAMETER_VERTEX_ATTRIB", 14],
        ["V86GL_PARAMETER_ARRAY_POINTER", 15],
        ["V86GL_PARAMETER_QUERY_TARGET", 16],
        ["V86GL_PARAMETER_ATTACHED_SHADERS", 17],
        ["V86GL_TEXT_SHADER_SOURCE", 0x10001],
        ["V86GL_OBJECT_KIND_SHADER", 1],
        ["V86GL_OBJECT_KIND_PROGRAM", 2],
        ["V86GL_OBJECT_KIND_QUERY", 3],
        ["V86GL_OBJECT_KIND_TEXTURE", 4],
        ["V86GL_OBJECT_KIND_RENDERBUFFER", 5],
        ["V86GL_OBJECT_KIND_FRAMEBUFFER", 6],
        ["V86GL_OBJECT_KIND_BUFFER", 7],
        ["V86GL_OBJECT_KIND_ARB_PROGRAM", 8],
        ["V86GL_QUERY_VISIBLE_SAMPLES", 0x7FFFFFFF],
        ["V86GL_ACTIVE_KIND_UNIFORM", 1],
        ["V86GL_ACTIVE_KIND_ATTRIB", 2],
        ["V86GL_LOCATION_KIND_UNIFORM", 1],
        ["V86GL_LOCATION_KIND_ATTRIB", 2],
        ["V86GL_PROGRAM_PARAMETER_ENV", 1],
        ["V86GL_PROGRAM_PARAMETER_LOCAL", 2],
        ["V86GL_QUERY_HOST_CAPABILITIES", 0x76380001,
            "QUERY_INTEGER's private host-capability bitset: optional extensions are only advertised when the " +
            "renderer backs them"],
        ["V86GL_HOST_CAP_WEBGL2", 0x1],
        ["V86GL_HOST_CAP_COLOR_BUFFER_FLOAT", 0x2],
        ["V86GL_HOST_CAP_TEXTURE_FLOAT_LINEAR", 0x4],
        ["V86GL_HOST_CAP_ANISOTROPY", 0x8],
        ["CLIENT_ARRAY_MT_MAGIC", 0x544D4143, "'CAMT' little-endian"],
        ["CLIENT_ARRAY_MT_SECONDARY_COLOR_BIT", 0x80000000],
        ["CLIENT_ARRAY_MT_FOG_COORD_BIT", 0x40000000],
    ];

    // DEFINES by name, as numbers
    const C = {};
    for (const [name, value] of DEFINES) {
        const shift = typeof value === "string" && value.match(/^\(1u << (\d+)\)$/);
        if (typeof value !== "number" && !shift) throw new Error("GL protocol: cannot evaluate " + name);
        C[name] = typeof value === "number" ? value : (1 << +shift[1]) >>> 0;
    }

    const BYTES = { i: 4, u: 4, f: 4, d: 8 };
    const C_TYPES = { i: "int32_t", u: "uint32_t", f: "float", d: "double" };

    const GLFN = {};
    const NAME_BY_OPCODE = [];
    // flat records: name -> [GL entry point, argument codes]
    const SIGNATURES = {};
    // fixed headers: name -> { size, fields: { field: { type, offset, count, bytes } } }
    const RECORDS = {};
    // name -> { field: offset }
    const F = {};
    function describe(name, layout) {
        if (RECORDS[name]) throw new Error("GL protocol: " + name + " is described twice");
        const fields = {};
        let offset = 0;
        for (const word of layout.split(" ")) {
            const [type, spec] = word.split(":");
            const [, field, count] = spec.match(/^(\w+)(?:\[(\d+)\])?$/);
            const n = count ? +count : 1;
            // natural alignment, as a C compiler lays the struct out
            offset = offset + BYTES[type] - 1 & ~(BYTES[type] - 1);
            fields[field] = { type, offset, count: n, bytes: BYTES[type] * n };
            offset += BYTES[type] * n;
        }
        RECORDS[name] = { size: offset, fields };
        F[name] = Object.fromEntries(Object.entries(fields).map(([field, f]) => [field, f.offset]));
    }
    for (const [name, opcode, glName, layout] of OPCODES) {
        if (GLFN[name] !== undefined || NAME_BY_OPCODE[opcode] !== undefined)
            throw new Error("GL protocol: " + name + " or opcode " + opcode + " is listed twice");
        GLFN[name] = opcode;
        NAME_BY_OPCODE[opcode] = name;
        if (glName) SIGNATURES[name] = [glName, layout];
        else if (layout) describe(name, layout);
    }
    for (const [name, , layout] of CONTROL) if (layout) describe(name, layout);
    for (const [name, layout] of COMPOSITES) describe(name, layout);

    function payloadBytes(types) {
        let n = 0;
        for (const t of types) n += BYTES[t];
        return n;
    }

    /* Decodes one flat argument list into `out`, returning the count. The
     * caller supplies the array so a hot draw path does not allocate. */
    function decodeArgs(types, view, offset, length, out) {
        let cursor = offset;
        const end = offset + length;
        for (let i = 0; i < types.length; ++i) {
            const t = types[i];
            const size = BYTES[t];
            if (cursor + size > end) return -1;
            switch (t) {
            case "i": out[i] = view.getInt32(cursor, true); break;
            case "u": out[i] = view.getUint32(cursor, true); break;
            case "f": out[i] = view.getFloat32(cursor, true); break;
            default: out[i] = view.getFloat64(cursor, true); break;
            }
            cursor += size;
        }
        return types.length;
    }

    const READ = {
        i: (view, at) => view.getInt32(at, true), u: (view, at) => view.getUint32(at, true),
        f: (view, at) => view.getFloat32(at, true), d: (view, at) => view.getFloat64(at, true),
    };
    const WRITE = {
        i: (view, at, v) => view.setInt32(at, v, true), u: (view, at, v) => view.setUint32(at, v >>> 0, true),
        f: (view, at, v) => view.setFloat32(at, v, true), d: (view, at, v) => view.setFloat64(at, v, true),
    };

    // A fixed header as an object (arrays as arrays)
    function decodeRecord(name, view, offset) {
        const out = {};
        for (const [field, f] of Object.entries(RECORDS[name].fields)) {
            const one = i => READ[f.type](view, offset + f.offset + i * BYTES[f.type]);
            out[field] = f.count === 1 ? one(0) : Array.from({ length: f.count }, (_, i) => one(i));
        }
        return out;
    }

    // A fixed header from an object (absent fields 0), for tests and encoders
    function encodeRecord(name, values) {
        const bytes = new Uint8Array(RECORDS[name].size);
        const view = new DataView(bytes.buffer);
        for (const [field, f] of Object.entries(RECORDS[name].fields)) {
            const value = values[field];
            if (value === undefined) continue;
            (f.count === 1 ? [value] : value).forEach((v, i) => WRITE[f.type](view, f.offset + i * BYTES[f.type], v));
        }
        return bytes;
    }

    // One flat record's payload from its arguments
    function encodeArgs(name, args) {
        const types = SIGNATURES[name][1];
        const bytes = new Uint8Array(payloadBytes(types));
        const view = new DataView(bytes.buffer);
        let at = 0;
        [...types].forEach((t, i) => { WRITE[t](view, at, args[i]); at += BYTES[t]; });
        return bytes;
    }

    function encodeProgramInterface(fields, entries, initializers = []) {
        const text = new TextEncoder(), rows = entries.map(entry => ({ entry, name: text.encode(entry.name) })), header = RECORDS.RESOLVED_PROGRAM_INTERFACE.size,
            dataSize = rows.reduce((sum, row) => sum + RECORDS.PROGRAM_INTERFACE_ENTRY.size + Math.ceil(row.name.length / 4) * 4, 0) +
                initializers.reduce((sum, row) => sum + 8 + row.values.length * 8, 0), bytes = new Uint8Array(header + dataSize);
        bytes.set(encodeRecord("RESOLVED_PROGRAM_INTERFACE", { ...fields, entry_count: rows.length, data_size: dataSize, initializer_count: initializers.length }));
        let at = header;
        for (const { entry, name } of rows) {
            bytes.set(encodeRecord("PROGRAM_INTERFACE_ENTRY", { ...entry, name_length: name.length }), at); at += RECORDS.PROGRAM_INTERFACE_ENTRY.size;
            bytes.set(name, at); at += Math.ceil(name.length / 4) * 4;
        }
        const view = new DataView(bytes.buffer);
        for (const row of initializers) {
            view.setInt32(at, row.location, true);view.setUint32(at + 4, row.values.length, true);at += 8;
            for (const value of row.values) {view.setFloat64(at, value, true);at += 8;}
        }
        return bytes;
    }

    function decodeProgramInterface(view, offset, size) {
        const header = RECORDS.RESOLVED_PROGRAM_INTERFACE.size, rowSize = RECORDS.PROGRAM_INTERFACE_ENTRY.size;
        if (size < header) throw new Error("short GL program interface");
        const r = decodeRecord("RESOLVED_PROGRAM_INTERFACE", view, offset), entries = [], initializers = [], text = new TextDecoder("utf-8", { fatal: true });
        if (!r.object_id || !r.link_generation || r.entry_count > 32768 || r.initializer_count > 32768 || r.data_size !== size - header) throw new Error("invalid GL program interface header");
        let at = offset + header;
        for (let i = 0; i < r.entry_count; ++i) {
            if (at + rowSize > offset + size) throw new Error("short GL program interface entry");
            const entry = decodeRecord("PROGRAM_INTERFACE_ENTRY", view, at); at += rowSize;
            if (![C.V86GL_LOCATION_KIND_UNIFORM, C.V86GL_LOCATION_KIND_ATTRIB].includes(entry.location_kind) || entry.location < 0 || entry.value_count < 1 ||
                entry.name_length > offset + size - at) throw new Error("invalid GL program interface entry");
            entry.name = text.decode(new Uint8Array(view.buffer, view.byteOffset + at, entry.name_length));
            at += Math.ceil(entry.name_length / 4) * 4; entries.push(entry);
        }
        for (let i = 0; i < r.initializer_count; ++i) {
            if (at + 8 > offset + size) throw new Error("short GL uniform initializer");
            const location = view.getInt32(at, true), count = view.getUint32(at + 4, true);at += 8;
            if (location < 0 || count < 1 || count > 16 || at + count * 8 > offset + size) throw new Error("invalid GL uniform initializer");
            const values = [];
            for (let k = 0; k < count; ++k) {values.push(view.getFloat64(at, true));at += 8;}
            initializers.push({location, values});
        }
        if (at !== offset + size) throw new Error("invalid GL program interface span");
        return { ...r, entries, initializers };
    }

    function isRejected(opcode) {
        return (opcode & C.V86GL_REJECTED_RECORD_MASK) === C.V86GL_REJECTED_RECORD_BIT ||
            (opcode & C.V86GL_REJECTED_EXTENDED_MASK) === C.V86GL_REJECTED_EXTENDED_BIT;
    }
    function rejectionError(opcode) {
        if ((opcode & C.V86GL_REJECTED_EXTENDED_MASK) === C.V86GL_REJECTED_EXTENDED_BIT)
            return C.V86GL_REJECTED_ERROR_BASE + ((opcode & C.V86GL_REJECTED_EXTENDED_ERROR_MASK) >>> C.V86GL_REJECTED_EXTENDED_ERROR_SHIFT);
        return C.V86GL_REJECTED_ERROR_BASE + ((opcode & C.V86GL_REJECTED_ERROR_MASK) >>> C.V86GL_REJECTED_ERROR_SHIFT);
    }
    function rejectedSourceOpcode(opcode) {
        return opcode & ((opcode & C.V86GL_REJECTED_EXTENDED_MASK) === C.V86GL_REJECTED_EXTENDED_BIT ? C.V86GL_MAX_OPCODE : C.V86GL_REJECTED_OPCODE_MASK);
    }
    function rejectedOpcode(opcode, error) {
        if (!Number.isInteger(opcode) || opcode < 1 || opcode > C.V86GL_MAX_OPCODE ||
                !Number.isInteger(error) || error < 0x500 || error > 0x506)
            throw new RangeError("GL rejected-record opcode or error is out of range");
        if (opcode > C.V86GL_REJECTED_OPCODE_MASK) return C.V86GL_REJECTED_EXTENDED_BIT |
            (error - C.V86GL_REJECTED_ERROR_BASE) << C.V86GL_REJECTED_EXTENDED_ERROR_SHIFT | opcode;
        return C.V86GL_REJECTED_RECORD_BIT | (error - C.V86GL_REJECTED_ERROR_BASE) << C.V86GL_REJECTED_ERROR_SHIFT | opcode;
    }

    const api = { OPCODES, CONTROL, CTRL, DEFINES, C, BYTES, C_TYPES, GLFN, NAME_BY_OPCODE, SIGNATURES, RECORDS, F,
        payloadBytes, decodeArgs, decodeRecord, encodeRecord, encodeArgs, encodeProgramInterface, decodeProgramInterface, isRejected, rejectionError, rejectedOpcode, rejectedSourceOpcode };
    global.GLProtocol = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
