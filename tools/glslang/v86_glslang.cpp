// The GLES host's GLSL ES compiler (docs/gles3-plan.md L1): glslang, built
// for WebAssembly by tools/glslang/build.sh into bios/glslang.wasm, with
// this interface for src/gles/glslang.js. No JavaScript glue: the module
// exports C functions and imports almost nothing (WASI stubs).
//
// Two passes over a program's shaders:
// - "check" (v86_glslang_compile, v86_glslang_link): OpenGL ES's own rules
//   at the shader's real version (100, 300 es, 310 es, 320 es), no SPIR-V:
//   the compile and link status, the info logs, and GL's reflection (active
//   uniforms, blocks, buffer variables, program inputs and outputs, with GL
//   type enums, array sizes, offsets and strides);
// - "code" (v86_glslang_spirv): SPIR-V for each stage under Vulkan's relaxed
//   rules (default uniforms gathered into gl_DefaultUniformBlock, atomic
//   counters into gl_AtomicCounterBlock), bindings and locations mapped
//   automatically (the host rewrites them after, by name), and the
//   reflection of that program (the default block's offsets).
//
// A program comes packed: for each stage a u32 stage (EShLanguage), a u32
// length and the source, padded to 4 bytes. Results are left in one output
// buffer (v86_glslang_output, v86_glslang_output_size): text for compile,
// JSON for link, and for spirv a u32 JSON length, the JSON (padded to 4),
// then per stage a u32 stage, a u32 word count and the words.

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "glslang/Include/Types.h"
#include "glslang/Public/ResourceLimits.h"
#include "glslang/Public/ShaderLang.h"
#include "SPIRV/GlslangToSpv.h"

namespace {

std::string output;
TBuiltInResource resources;
bool initialized = false;

struct Source
{
    EShLanguage stage;
    std::string text;
};

std::vector<Source> unpack(const uint8_t* packed, uint32_t length)
{
    std::vector<Source> sources;
    uint32_t at = 0;
    while(at + 8 <= length)
    {
        uint32_t stage, size;
        memcpy(&stage, packed + at, 4);
        memcpy(&size, packed + at + 4, 4);
        at += 8;
        if(size > length - at) break;
        sources.push_back({ static_cast<EShLanguage>(stage), std::string(reinterpret_cast<const char*>(packed + at), size) });
        at += (size + 3) & ~3u;
    }
    return sources;
}

void json_string(std::string& out, const std::string& text)
{
    out += '"';
    for(unsigned char c : text)
    {
        switch(c)
        {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if(c < 0x20)
                {
                    char escape[8];
                    snprintf(escape, sizeof escape, "\\u%04x", c);
                    out += escape;
                }
                else out += static_cast<char>(c);
        }
    }
    out += '"';
}

void json_field(std::string& out, const char* name, long long value, bool first = false)
{
    if(!first) out += ',';
    out += '"';
    out += name;
    out += "\":";
    out += std::to_string(value);
}

const char* packing_name(glslang::TLayoutPacking packing)
{
    switch(packing)
    {
        case glslang::ElpStd140: return "std140";
        case glslang::ElpStd430: return "std430";
        case glslang::ElpPacked: return "packed";
        case glslang::ElpShared: return "shared";
        case glslang::ElpScalar: return "scalar";
        default: return "none";
    }
}

/** One reflected object as JSON: the fields TObjectReflection has, and from its type the matrix layout and qualifiers GL asks about */
void json_object(std::string& out, const glslang::TObjectReflection& o)
{
    out += "{\"name\":";
    json_string(out, o.name);
    json_field(out, "offset", o.offset);
    json_field(out, "type", o.glDefineType);
    json_field(out, "size", o.size);
    json_field(out, "index", o.index);
    json_field(out, "counterIndex", o.counterIndex);
    json_field(out, "numMembers", o.numMembers);
    json_field(out, "arrayStride", o.arrayStride);
    json_field(out, "topLevelArraySize", o.topLevelArraySize);
    json_field(out, "topLevelArrayStride", o.topLevelArrayStride);
    json_field(out, "stages", o.stages);
    const glslang::TType* type = o.getType();
    if(type)
    {
        const glslang::TQualifier& q = type->getQualifier();
        json_field(out, "binding", q.hasBinding() ? q.layoutBinding : -1);
        json_field(out, "location", q.hasLocation() ? q.layoutLocation : -1);
        json_field(out, "rowMajor", q.layoutMatrix == glslang::ElmRowMajor);
        json_field(out, "flat", q.flat);
        json_field(out, "arrayDims", type->isArray() ? type->getArraySizes()->getNumDims() : 0);
        json_field(out, "builtIn", q.builtIn != glslang::EbvNone);
        json_field(out, "matrixCols", type->isMatrix() ? type->getMatrixCols() : 0);
        json_field(out, "matrixRows", type->isMatrix() ? type->getMatrixRows() : 0);
        json_field(out, "readonly", q.readonly);
        json_field(out, "writeonly", q.writeonly);
        out += ",\"packing\":";
        json_string(out, packing_name(q.layoutPacking));
        out += ",\"storage\":";
        json_string(out, glslang::GetStorageQualifierString(q.storage));
        if(q.hasFormat())
        {
            out += ",\"format\":";
            json_string(out, glslang::TQualifier::getLayoutFormatString(q.getFormat()));
        }
    }
    out += '}';
}

void json_list(std::string& out, const char* name, int count, const std::function<const glslang::TObjectReflection&(int)>& get)
{
    out += ",\"";
    out += name;
    out += "\":[";
    for(int i = 0; i < count; i++)
    {
        if(i) out += ',';
        json_object(out, get(i));
    }
    out += ']';
}

void json_reflection(std::string& out, glslang::TProgram& program)
{
    json_list(out, "uniforms", program.getNumUniformVariables(), [&](int i) -> const glslang::TObjectReflection& { return program.getUniform(i); });
    json_list(out, "uniformBlocks", program.getNumUniformBlocks(), [&](int i) -> const glslang::TObjectReflection& { return program.getUniformBlock(i); });
    json_list(out, "bufferVariables", program.getNumBufferVariables(), [&](int i) -> const glslang::TObjectReflection& { return program.getBufferVariable(i); });
    json_list(out, "bufferBlocks", program.getNumBufferBlocks(), [&](int i) -> const glslang::TObjectReflection& { return program.getBufferBlock(i); });
    json_list(out, "inputs", program.getNumPipeInputs(), [&](int i) -> const glslang::TObjectReflection& { return program.getPipeInput(i); });
    json_list(out, "outputs", program.getNumPipeOutputs(), [&](int i) -> const glslang::TObjectReflection& { return program.getPipeOutput(i); });
    json_list(out, "atomicCounters", program.getNumAtomicCounters(), [&](int i) -> const glslang::TObjectReflection& { return program.getAtomicCounter(i); });
    out += ",\"localSize\":[";
    for(int i = 0; i < 3; i++)
    {
        if(i) out += ',';
        out += std::to_string(program.getLocalSize(i));
    }
    out += ']';
}

// (IntermediateIO: the inputs of the program's first stage and the outputs of its last, GL's PROGRAM_INPUT and _OUTPUT;
// without it, the vertex stage's and the fragment stage's only, none of a separable fragment or vertex program)
const int CHECK_REFLECTION = EShReflectionBasicArraySuffix | EShReflectionStrictArraySuffix | EShReflectionSeparateBuffers |
    EShReflectionAllBlockVariables | EShReflectionUnwrapIOBlocks | EShReflectionSharedStd140SSBO | EShReflectionSharedStd140UBO |
    EShReflectionIntermediateIO;

/** A shader of the check pass: GL ES at its own version, no SPIR-V */
std::unique_ptr<glslang::TShader> check_shader(const Source& source, bool& ok)
{
    auto shader = std::make_unique<glslang::TShader>(source.stage);
    const char* text = source.text.c_str();
    int length = static_cast<int>(source.text.size());
    shader->setStringsWithLengths(&text, &length, 1);
    shader->setEnvInput(glslang::EShSourceGlsl, source.stage, glslang::EShClientNone, 0);
    ok = shader->parse(&resources, 100, ENoProfile, false, false, EShMsgDefault);
    return shader;
}

/** A shader of the code pass: Vulkan's relaxed rules, SPIR-V 1.0 */
std::unique_ptr<glslang::TShader> code_shader(const Source& source, bool& ok)
{
    auto shader = std::make_unique<glslang::TShader>(source.stage);
    const char* text = source.text.c_str();
    int length = static_cast<int>(source.text.size());
    shader->setStringsWithLengths(&text, &length, 1);
    shader->setEnvInput(glslang::EShSourceGlsl, source.stage, glslang::EShClientVulkan, 100);
    shader->setEnvClient(glslang::EShClientVulkan, glslang::EShTargetVulkan_1_0);
    shader->setEnvTarget(glslang::EShTargetSpv, glslang::EShTargetSpv_1_0);
    shader->setEnvInputVulkanRulesRelaxed();
    shader->setGlobalUniformBlockName("gl_DefaultUniformBlock");
    shader->setGlobalUniformSet(0);
    shader->setGlobalUniformBinding(0);
    shader->setAtomicCounterBlockName("gl_AtomicCounterBlock");
    shader->setAtomicCounterBlockSet(0);
    shader->setAutoMapBindings(true);
    shader->setAutoMapLocations(true);
    ok = shader->parse(&resources, 100, ENoProfile, false, false,
        static_cast<EShMessages>(EShMsgSpvRules | EShMsgVulkanRules));
    return shader;
}

void init()
{
    if(initialized) return;
    glslang::InitializeProcess();
    resources = *GetDefaultResources();
    // GLSL ES 1.00's appendix A: everything a desktop GPU does
    resources.limits.nonInductiveForLoops = true;
    resources.limits.whileLoops = true;
    resources.limits.doWhileLoops = true;
    resources.limits.generalUniformIndexing = true;
    resources.limits.generalAttributeMatrixVectorIndexing = true;
    resources.limits.generalVaryingIndexing = true;
    resources.limits.generalSamplerIndexing = true;
    resources.limits.generalVariableIndexing = true;
    resources.limits.generalConstantMatrixVectorIndexing = true;
    initialized = true;
}

} // namespace

extern "C" {

__attribute__((export_name("v86_glslang_alloc"))) void* v86_glslang_alloc(uint32_t size) { return malloc(size); }
__attribute__((export_name("v86_glslang_free"))) void v86_glslang_free(void* pointer) { free(pointer); }
__attribute__((export_name("v86_glslang_output"))) const char* v86_glslang_output() { return output.data(); }
__attribute__((export_name("v86_glslang_output_size"))) uint32_t v86_glslang_output_size() { return static_cast<uint32_t>(output.size()); }

/** The limits gl_Max* and the checks see, as glslangValidator's configuration text ("MaxDrawBuffers 4", one a line) */
__attribute__((export_name("v86_glslang_limits")))
void v86_glslang_limits(char* config)
{
    init();
    DecodeResourceLimits(&resources, config);
}

/** The check pass of one shader: 1 if it compiles; the output is its info log */
__attribute__((export_name("v86_glslang_compile")))
int v86_glslang_compile(const uint8_t* packed, uint32_t length)
{
    init();
    std::vector<Source> sources = unpack(packed, length);
    output.clear();
    if(sources.size() != 1) { output = "one shader expected"; return 0; }
    bool ok;
    auto shader = check_shader(sources[0], ok);
    output = shader->getInfoLog();
    // OpenGL ES has one shader a stage, so what glslang finds linking the
    // stage alone (gl_FragColor beside gl_FragData, a function with no
    // body) is the shader's error, as ES's compilers report it
    if(ok)
    {
        glslang::TProgram program;
        program.addShader(shader.get());
        if(!program.link(EShMsgDefault))
        {
            ok = false;
            output += program.getInfoLog();
        }
    }
    return ok ? 1 : 0;
}

/**
 * The check pass of a program: 1 if it links. The output is JSON: the
 * link's info log and, when it linked, GL's reflection.
 * flags: bit 0 separable (glProgramParameteri PROGRAM_SEPARABLE)
 */
__attribute__((export_name("v86_glslang_link")))
int v86_glslang_link(const uint8_t* packed, uint32_t length, uint32_t flags)
{
    init();
    std::vector<Source> sources = unpack(packed, length);
    output.clear();
    std::vector<std::unique_ptr<glslang::TShader>> shaders;
    glslang::TProgram program;
    std::string log;
    bool ok = !sources.empty();
    for(const Source& source : sources)
    {
        bool compiled;
        shaders.push_back(check_shader(source, compiled));
        if(!compiled) { ok = false; log += shaders.back()->getInfoLog(); }
        program.addShader(shaders.back().get());
    }
    (void)flags;
    if(ok && !program.link(EShMsgDefault)) ok = false;
    log += program.getInfoLog();
    output = "{\"ok\":";
    output += ok ? "true" : "false";
    output += ",\"log\":";
    json_string(output, log);
    if(ok && program.buildReflection(CHECK_REFLECTION)) json_reflection(output, program);
    output += '}';
    return ok ? 1 : 0;
}

/** The code pass of a program that linked in the check pass: SPIR-V per stage (layout in the file's comment) */
__attribute__((export_name("v86_glslang_spirv")))
int v86_glslang_spirv(const uint8_t* packed, uint32_t length, uint32_t flags)
{
    init();
    std::vector<Source> sources = unpack(packed, length);
    output.clear();
    std::vector<std::unique_ptr<glslang::TShader>> shaders;
    glslang::TProgram program;
    std::string log;
    bool ok = !sources.empty();
    for(const Source& source : sources)
    {
        bool compiled;
        shaders.push_back(code_shader(source, compiled));
        if(!compiled) { ok = false; log += shaders.back()->getInfoLog(); }
        program.addShader(shaders.back().get());
    }
    (void)flags;
    const auto messages = static_cast<EShMessages>(EShMsgSpvRules | EShMsgVulkanRules);
    if(ok && !program.link(messages)) ok = false;
    if(ok && !program.mapIO()) ok = false;
    log += program.getInfoLog();
    std::string json = "{\"ok\":";
    json += ok ? "true" : "false";
    json += ",\"log\":";
    json_string(json, log);
    if(ok && program.buildReflection(CHECK_REFLECTION)) json_reflection(json, program);
    json += '}';
    std::vector<std::pair<int, std::vector<unsigned int>>> modules;
    if(ok)
    {
        for(const Source& source : sources)
        {
            const glslang::TIntermediate* intermediate = program.getIntermediate(source.stage);
            if(!intermediate) continue;
            glslang::SpvOptions options;
            options.disableOptimizer = true;
            spv::SpvBuildLogger logger;
            std::vector<unsigned int> words;
            glslang::GlslangToSpv(*intermediate, words, &logger, &options);
            modules.push_back({ source.stage, std::move(words) });
        }
    }
    uint32_t json_length = static_cast<uint32_t>(json.size());
    output.append(reinterpret_cast<const char*>(&json_length), 4);
    output += json;
    while(output.size() & 3) output += ' ';
    for(const auto& [stage, words] : modules)
    {
        uint32_t header[2] = { static_cast<uint32_t>(stage), static_cast<uint32_t>(words.size()) };
        output.append(reinterpret_cast<const char*>(header), 8);
        output.append(reinterpret_cast<const char*>(words.data()), words.size() * 4);
    }
    return ok ? 1 : 0;
}

}
