// E0 experiment only: lower desktop built-ins in typed IR, never shader text.
#pragma once
#include <algorithm>
#include <map>
#include <string>
#include <vector>
#include "glslang/MachineIndependent/localintermediate.h"
namespace glslang {
class DesktopLegacyLowering : public TIntermTraverser {
public:
    DesktopLegacyLowering(TIntermediate& ir, bool color, bool secondary, const std::map<std::string, const TType*>& schema) : TIntermTraverser(true, false, false), ir(ir), maximum(0), collect(true), ftransform(false), needColor(color), needSecondary(secondary), block(nullptr), face(nullptr), uniformSchema(schema) {}
    void run() {
        if (ir.getStage() == EShLangFragment) ir.setOriginUpperLeft();
        ir.getTreeRoot()->traverse(this);collect = false;
        auto root = ir.getTreeRoot()->getAsAggregate();TIntermAggregate* objects = nullptr;
        for (auto node : root->getSequence()) if (node->getAsAggregate() && node->getAsAggregate()->getOp() == EOpLinkerObjects) objects = node->getAsAggregate();
        if (!objects) {objects = new TIntermAggregate(EOpLinkerObjects);root->getSequence().push_back(objects);}
        if (ftransform) {obtainMatrix();obtainInput("gl_Vertex", 0, 4);}
        makeUniformBlock();
        auto& globals = objects->getSequence();globals.erase(std::remove_if(globals.begin(), globals.end(), [&](TIntermNode* n) {return n->getAsSymbolNode() && n->getAsSymbolNode()->getQualifier().storage == EvqUniform && uniformMembers.count(n->getAsSymbolNode()->getName().c_str());}), globals.end());
        if (ir.getStage() == EShLangVertex) {
            if (needColor) {ensureOutput("gl_FrontColor", 0);ensureOutput("gl_BackColor", 11);}
            if (needSecondary) {ensureOutput("gl_FrontSecondaryColor", 1);ensureOutput("gl_BackSecondaryColor", 12);}
        }
        ir.getTreeRoot()->traverse(this);
        for (auto symbol : introduced) if (!uniformMembers.count(symbol->getName().c_str())) globals.push_back(symbol);
    }
    void visitSymbol(TIntermSymbol* symbol) override {
        if (collect) {maximum = std::max(maximum, symbol->getId());auto existing = symbols.find(symbol->getName().c_str());
            if (existing == symbols.end() || symbol->getQualifier().storage == EvqUniform) symbols[symbol->getName().c_str()] = symbol;return;}
        const std::string name = symbol->getName().c_str();
        if (symbol->getQualifier().storage == EvqUniform && uniformMembers.count(name)) {replace(symbol, uniformAccess(name));return;}
        normalize(symbol);
        if (ir.getStage() == EShLangFragment && (name == "gl_Color" || name == "gl_SecondaryColor")) {
            const bool secondary = name == "gl_SecondaryColor";auto back = obtainInput(secondary ? "v86_BackSecondary" : "v86_BackColor", secondary ? 12 : 11, 4);
            if (!face) {
                auto found = symbols.find("gl_FrontFacing");
                if (found != symbols.end()) face = found->second;
                else {TType type(EbtBool, EvqVaryingIn, EpqNone);type.getQualifier().builtIn = EbvFace;face = newSymbol("gl_FrontFacing", type);}
            }
            replace(symbol, new TIntermSelection(face, symbol, back, symbol->getType()));
        }
    }
    bool visitAggregate(TVisit, TIntermAggregate* node) override {
        if (node->getOp() != EOpFtransform) return true;
        if (collect) {ftransform = true;return true;}
        auto vertex = obtainInput("gl_Vertex", 0, 4);normalize(vertex);
        auto product = new TIntermBinary(EOpMatrixTimesVector);product->setLeft(uniformAccess("gl_ModelViewProjectionMatrix"));product->setRight(vertex);product->setType(node->getType());product->setLoc(node->getLoc());replace(node, product);return false;
    }
    bool unsupported = false;
private:
    void normalize(TIntermSymbol* symbol) {
        auto& q = symbol->getWritableType().getQualifier();int location = -1;bool input = ir.getStage() == EShLangVertex;
        switch (q.builtIn) {
        case EbvVertex: location = 0;break;
        case EbvNormal: location = 2;break;
        case EbvColor: location = input ? 1 : 0;input = true;break;
        case EbvSecondaryColor: location = input ? 3 : 1;input = true;break;
        case EbvMultiTexCoord0: case EbvMultiTexCoord1: case EbvMultiTexCoord2: case EbvMultiTexCoord3:
        case EbvMultiTexCoord4: case EbvMultiTexCoord5: case EbvMultiTexCoord6: case EbvMultiTexCoord7: location = 8 + q.builtIn - EbvMultiTexCoord0;break;
        case EbvFrontColor: location = 0;input = false;break;
        case EbvBackColor: location = 11;input = false;break;
        case EbvFrontSecondaryColor: location = 1;input = false;break;
        case EbvBackSecondaryColor: location = 12;input = false;break;
        case EbvFogFragCoord: location = 2;input = ir.getStage() == EShLangFragment;break;
        case EbvTexCoord: location = 3;input = ir.getStage() == EShLangFragment;break;
        case EbvClipVertex: location = 15;input = false;break;
        case EbvPointSize: location = 13;input = false;break;
        case EbvPointCoord: location = 14;input = true;break;
        case EbvFragColor: case EbvFragData: location = 0;input = false;break;
        default: break;
        }
        if (location >= 0) {q.builtIn = EbvNone;q.storage = input ? EvqVaryingIn : EvqVaryingOut;q.layoutLocation = location;}
    }
    TIntermSymbol* newSymbol(const char* name, const TType& type) {
        auto symbol = new TIntermSymbol(++maximum, TString(name), ir.getStage(), type);symbols.emplace(name, symbol);introduced.push_back(symbol);ir.addIoAccessed(symbol->getName());return symbol;
    }
    TIntermSymbol* obtainInput(const char* name, int location, int width) {
        auto found = symbols.find(name);if (found != symbols.end()) return found->second;
        TType type(EbtFloat, EvqVaryingIn, EpqHigh, width);type.getQualifier().layoutLocation = location;return newSymbol(name, type);
    }
    void obtainMatrix() {
        if (symbols.count("gl_ModelViewProjectionMatrix")) return;
        TType type(EbtFloat, EvqUniform, EpqHigh, 1, 4, 4);newSymbol("gl_ModelViewProjectionMatrix", type);
    }
    TIntermTyped* index(int value) {
        TConstUnionArray values(1);values[0].setIConst(value);return new TIntermConstantUnion(values, TType(EbtInt, EvqConst, EpqHigh));
    }
    void makeUniformBlock() {
        auto members = new TTypeList;int offset = 0;
        for (const auto& entry : uniformSchema) {
            auto member = new TType;member->shallowCopy(*entry.second);member->setFieldName(TString(entry.first.c_str()));auto& q = member->getQualifier();q.builtIn = EbvNone;q.clearLayout();
            int size, stride;const int alignment = TIntermediate::getBaseAlignment(*member, size, stride, ElpStd140, false);offset = (offset + alignment - 1) / alignment * alignment;q.layoutOffset = offset;offset += size;
            TSourceLoc loc;loc.init();uniformMembers.emplace(entry.first, static_cast<int>(members->size()));members->push_back({member, loc});
        }
        if (members->empty()) return;
        TQualifier q;q.clear();q.storage = EvqUniform;q.layoutPacking = ElpStd140;q.layoutMatrix = ElmColumnMajor;q.layoutSet = 0;q.layoutBinding = 31;
        TType type(members, TString("v86_DesktopState"), q);block = newSymbol("v86_DesktopState", type);
    }
    TIntermTyped* uniformAccess(const std::string& name) {
        auto access = new TIntermBinary(EOpIndexDirectStruct);access->setLeft(block);access->setRight(index(uniformMembers.at(name)));access->setType(symbols.at(name)->getType());return access;
    }
    void ensureOutput(const char* name, int location) {
        auto found = symbols.find(name);if (found != symbols.end() && ir.inIoAccessed(found->second->getName())) return;
        TType type(EbtFloat, EvqVaryingOut, EpqHigh, 4);type.getQualifier().layoutLocation = location;auto symbol = found != symbols.end() ? found->second : newSymbol(name, type);symbol->getWritableType().shallowCopy(type);
        TConstUnionArray values(4);for (int i = 0; i < 4; ++i) values[i].setDConst(0);
        auto zero = new TIntermConstantUnion(values, TType(EbtFloat, EvqConst, EpqHigh, 4));
        auto assignment = new TIntermBinary(EOpAssign);assignment->setLeft(symbol);assignment->setRight(zero);assignment->setType(type);
        auto root = ir.getTreeRoot()->getAsAggregate();for (auto node : root->getSequence()) if (auto function = node->getAsAggregate()) if (function->getOp() == EOpFunction && function->getName().find("main(") == 0) {
            for (auto child : function->getSequence()) if (auto body = child->getAsAggregate()) if (body->getOp() == EOpSequence) body->getSequence().insert(body->getSequence().begin(), assignment);
        }
        ir.addIoAccessed(symbol->getName());
    }
    void replace(TIntermNode* old, TIntermTyped* value) {
        auto parent = getParentNode();
        if (auto binary = parent ? parent->getAsBinaryNode() : nullptr) {if (binary->getLeft() == old) binary->setLeft(value);else binary->setRight(value);}
        else if (auto aggregate = parent ? parent->getAsAggregate() : nullptr) {for (auto& child : aggregate->getSequence()) if (child == old) child = value;}
        else if (auto unary = parent ? parent->getAsUnaryNode() : nullptr) unary->setOperand(value);
        else if (auto branch = parent ? parent->getAsBranchNode() : nullptr) branch->setExpression(value);
        else if (auto selection = parent ? parent->getAsSelectionNode() : nullptr) {if (selection->getCondition() == old) selection->setCondition(value);else if (selection->getTrueBlock() == old) selection->setTrueBlock(value);else selection->setFalseBlock(value);}
        else unsupported = true;
    }
    TIntermediate& ir;long long maximum;bool collect, ftransform, needColor, needSecondary;TIntermSymbol *block, *face;
    const std::map<std::string, const TType*>& uniformSchema;
    std::map<std::string, TIntermSymbol*> symbols;std::vector<TIntermSymbol*> introduced;std::map<std::string, int> uniformMembers;
};
class DesktopLegacyNeeds : public TIntermTraverser {
public:
    DesktopLegacyNeeds() : TIntermTraverser(true, false, false) {}
    void visitSymbol(TIntermSymbol* symbol) override {
        const std::string name = symbol->getName().c_str();const auto& type = symbol->getType();
        if (fragment) {color |= name == "gl_Color";secondary |= name == "gl_SecondaryColor";}
        if (type.getQualifier().storage == EvqUniform && type.getBasicType() != EbtBlock && !type.isOpaque()) uniforms.emplace(name, &type);
        if (type.getQualifier().storage == EvqUniform && type.containsOpaque() && type.getBasicType() != EbtSampler) opaqueAggregate = name;
        if (type.getQualifier().storage == EvqUniform && symbol->getConstArray().size()) defaults.emplace(name, symbol->getConstArray().size());
    }
    bool visitAggregate(TVisit, TIntermAggregate* node) override {matrix |= node->getOp() == EOpFtransform;return true;}
    bool color = false, secondary = false, fragment = false, matrix = false;std::map<std::string, const TType*> uniforms;
    std::string opaqueAggregate;std::map<std::string,int> defaults;
};
inline bool desktop_lower_legacy_program(std::vector<std::unique_ptr<TShader>>& shaders, std::string* log = nullptr) {
    DesktopLegacyNeeds needs;
    for (auto& shader : shaders) {needs.fragment = shader->getIntermediate()->getStage() == EShLangFragment;shader->getIntermediate()->getTreeRoot()->traverse(&needs);}
    if (log) for (const auto& entry : needs.defaults) *log += "E0 uniform initializer " + entry.first + " words=" + std::to_string(entry.second) + "\n";
    if (!needs.opaqueAggregate.empty()) {if (log) *log += "E0 AST: opaque member in uniform aggregate needs separate lowering: " + needs.opaqueAggregate + "\n";return false;}
    if (needs.matrix && !needs.uniforms.count("gl_ModelViewProjectionMatrix")) needs.uniforms.emplace("gl_ModelViewProjectionMatrix", new TType(EbtFloat, EvqUniform, EpqHigh, 1, 4, 4));
    for (auto& shader : shaders) {DesktopLegacyLowering lowering(*shader->getIntermediate(), needs.color, needs.secondary, needs.uniforms);lowering.run();if (lowering.unsupported) return false;}
    return true;
}
}
