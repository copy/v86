#ifndef HELPERS_H_
#define HELPERS_H_

#include <v8.h>
#include <node.h>
#include <node_buffer.h>
#include <sstream>
#include <iostream>

#define S(x) #x
#define TOKENPASTE(x, y) x ## y
#define TOKENPASTE2(x, y) TOKENPASTE(x, y)

#ifdef ENABLE_ARG_CHECKING
#define CHECK_ARGLEN(function_name, num_args) \
	if(!args[0]->IsExternal() && args.Length() < num_args) { \
		std::stringstream ss; \
		ss << "Invalid arguments: Expected "; \
		ss << num_args; \
		ss << " arguments for function '"; \
		ss << S(function_name); \
		ss << "'."; \
		return v8::ThrowException(v8::Exception::TypeError( \
			v8::String::New(ss.str().c_str()))); \
	}

#define CHECK_STRING(arg_n) \
	if(!args[arg_n]->IsString()) { \
		std::stringstream ss; \
		ss << "Invalid arguments: Expected argument "; \
		ss << arg_n; \
		ss << " to be a String."; \
		return v8::ThrowException(v8::Exception::TypeError( \
			v8::String::New(ss.str().c_str()))); \
	}
#define CHECK_STRING_F(arg_n, function_name) \
	if(!args[arg_n]->IsString()) { \
		std::stringstream ss; \
		ss << "Invalid arguments: Expected argument "; \
		ss << arg_n; \
		ss << " to be a String. (function: "; \
		ss << S(function_name); \
		ss << ")"; \
		return v8::ThrowException(v8::Exception::TypeError( \
			v8::String::New(ss.str().c_str()))); \
	}

#define CHECK_NUMBER(arg_n) \
	if(!args[arg_n]->IsNumber()) { \
		std::stringstream ss; \
		ss << "Invalid arguments: Expected argument "; \
		ss << arg_n; \
		ss << " to be a Number."; \
		return v8::ThrowException(v8::Exception::TypeError( \
			v8::String::New(ss.str().c_str()))); \
	}
#define CHECK_NUMBER_F(arg_n, function_name) \
	if(!args[arg_n]->IsNumber()) { \
		std::stringstream ss; \
		ss << "Invalid arguments: Expected argument "; \
		ss << arg_n; \
		ss << " to be a Number. (function: "; \
		ss << S(function_name); \
		ss << ")"; \
		return v8::ThrowException(v8::Exception::TypeError( \
			v8::String::New(ss.str().c_str()))); \
	}

#define CHECK_BOOL(arg_n) \
	if(!args[arg_n]->IsBoolean()) { \
		std::stringstream ss; \
		ss << "Invalid arguments: Expected argument "; \
		ss << arg_n; \
		ss << " to be a Boolean."; \
		return v8::ThrowException(v8::Exception::TypeError( \
			v8::String::New(ss.str().c_str()))); \
	}
#define CHECK_BOOL_F(arg_n, function_name) \
	if(!args[arg_n]->IsBoolean()) { \
		std::stringstream ss; \
		ss << "Invalid arguments: Expected argument "; \
		ss << arg_n; \
		ss << " to be a Boolean. (function: "; \
		ss << S(function_name); \
		ss << ")"; \
		return v8::ThrowException(v8::Exception::TypeError( \
			v8::String::New(ss.str().c_str()))); \
	}

#define CHECK_WRAPPER(name, type) \
	if(NULL == name) { \
		std::stringstream ss; \
		ss << "Invalid call: Expected this to be a "; \
		ss << S(type); \
		ss << "."; \
		return v8::ThrowException(v8::Exception::TypeError( \
			v8::String::New(ss.str().c_str()))); \
	}

#define CHECK_CONSTRUCT(class_name) \
	if(!args.IsConstructCall()) { \
		std::stringstream ss; \
		ss << "Must use the new operator to create instances of class " << S(type); \
		return v8::ThrowException(v8::Exception::TypeError( \
			String::New(ss.str().c_str()))); \
	}

#define CHECK_EXTERNAL(arg_n) \
  if(!args[0]->IsExternal()) { \
    std::stringstream ss; \
    ss << "Invalid arguments: Expected argument "; \
    ss << arg_n; \
    ss << " to be an External."; \
    return v8::ThrowException(v8::Exception::TypeError( \
      v8::String::New(ss.str().c_str()))); \
  }
#else
#define CHECK_ARGLEN(function_name, num_args)

#define CHECK_STRING(arg_n)
#define CHECK_STRING_F(arg_n, function_name)

#define CHECK_NUMBER(arg_n)
#define CHECK_NUMBER_F(arg_n, function_name)

#define CHECK_BOOL(arg_n)
#define CHECK_BOOL_F(arg_n, function_name)

#define CHECK_WRAPPER(name, type)

#define CHECK_CONSTRUCT(class_name)

#define CHECK_EXTERNAL(arg_n)
#endif

#define FUNCTION_DEF(name) v8::Handle<v8::Value> name(const v8::Arguments& args)
#define FUNCTION_DEFP(prefix, name) v8::Handle<v8::Value> prefix::name(const v8::Arguments& args)
#define FUNCTION_BEGIN(name, num_args) FUNCTION_DEF(name) { \
	v8::HandleScope scope; \
	CHECK_ARGLEN(name, num_args);
#define FUNCTION_BEGINP(prefix, name, num_args) v8::Handle<v8::Value> prefix::name(const v8::Arguments& args) { \
	v8::HandleScope scope; \
	CHECK_ARGLEN(name, num_args);
#define FUNCTION_END(ret) return scope.Close(ret); \
}
#define FUNCTION_UNDEFINED return Undefined(); \
}

#define GETTER_DEF(func_name) v8::Handle<v8::Value> func_name(v8::Local<v8::String> name, const v8::AccessorInfo& info)
#define GETTER_DEFP(prefix, func_name) v8::Handle<v8::Value> prefix::func_name(v8::Local<v8::String> name, const v8::AccessorInfo& info)
#define GETTER_BEGIN(prefix, func_name) GETTER_DEFP(prefix, func_name) { \
	v8::HandleScope scope;
#define GETTER_END(ret) return scope.Close(ret); \
}
#define GETTER_UNDEFINED return Undefined(); \
}

#define SETTER_DEF(func_name) void func_name(v8::Local<v8::String> name, v8::Local<v8::Value> value, const v8::AccessorInfo& info)
#define SETTER_DEFP(prefix, func_name) void prefix::func_name(v8::Local<v8::String> name, v8::Local<v8::Value> value, const v8::AccessorInfo& info)
#define SETTER_BEGIN(prefix, func_name) SETTER_DEFP(prefix, func_name) { \
	v8::HandleScope scope;
#define SETTER_END }

#define EXTRACT_STRING(name, arg_n) \
	CHECK_STRING(arg_n); \
	v8::String::Utf8Value name(args[arg_n])
#define EXTRACT_BOOL(name, arg_n) \
	CHECK_BOOL(arg_n); \
	bool name = args[arg_n]->BooleanValue()
#define EXTRACT_NUMBER(name, arg_n) \
	CHECK_NUMBER(arg_n); \
	double name = args[arg_n]->NumberValue()
#define EXTRACT_INT64(name, arg_n) \
	CHECK_NUMBER(arg_n); \
	int64_t name = args[arg_n]->IntegerValue()
#define EXTRACT_INT32(name, arg_n) \
	CHECK_NUMBER(arg_n); \
	int name = args[arg_n]->Int32Value()
#define EXTRACT_UINT32(name, arg_n) \
	CHECK_NUMBER(arg_n); \
	uint32_t name = args[arg_n]->Uint32Value()

#ifdef ENABLE_ARG_CHECKING
#define VALUE_STRING(name) \
	if(value->IsString()) { \
		v8::String::Utf8Value name(value);
#define VALUE_BOOL(name) \
	if(value->IsBoolean()) { \
		bool name = value->BooleanValue();
#define VALUE_NUMBER(name) \
	if(value->IsNumber()) { \
		double name = value->NumberValue();
#define VALUE_INT64(name) \
	if(value->IsNumber()) { \
		int64_t name = value->IntegerValue();
#define VALUE_INT32(name) \
	if(value->IsInt32()) { \
		int name = value->Int32Value();
#define VALUE_UINT32(name) \
	if(value->IsUint32()) { \
		uint32_t name = value->Uint32Value();
#define UNWRAP_THIS_SETTER(type, from, name) type* name = node::ObjectWrap::Unwrap<type>(from.This()); \
	if(NULL != name) {
#define END_VALUE } else { \
	std::cout << "Unable to unwrap value in '" << __func__ << ":" << __LINE__ << "'." << std::endl; \
	}
#define UNWRAP_END } else { \
	std::cout << "Unable to unwrap 'this' in '" << __func__ << ":" << __LINE__ << "'." << std::endl; \
	}
#else
#define VALUE_STRING(name) \
	v8::String::Utf8Value name(value);
#define VALUE_BOOL(name) \
	bool name = value->BooleanValue();
#define VALUE_NUMBER(name) \
	double name = value->NumberValue();
#define VALUE_INT64(name) \
	int64_t name = value->IntegerValue();
#define VALUE_INT32(name) \
	int name = value->Int32Value();
#define VALUE_UINT32(name) \
	uint32_t name = value->Uint32Value();
#define UNWRAP_THIS_SETTER(type, from, name) \
	type* name = node::ObjectWrap::Unwrap<type>(from.This());
#define END_VALUE
#define UNWRAP_END
#endif

#define UNWRAP_THIS(type, from, name) type* name = node::ObjectWrap::Unwrap<type>(from.This()); \
	CHECK_WRAPPER(name, type)

#define OPEN_OBJECTWRAP(type) class type : public node::ObjectWrap { \
	public: \
		static v8::Persistent<v8::FunctionTemplate> wrap_template_; \
		~type(); \
		static void Init(v8::Handle<v8::Object> target); \
		static v8::Handle<v8::Value> New(const v8::Arguments& args);
#define CLOSE_OBJECTWRAP(wrap_type) wrap_type* wrapped; \
	};

#define CREATE_TEMPLATE(template, type) \
	v8::Local<v8::FunctionTemplate> tpl = v8::FunctionTemplate::New(New); \
	template = v8::Persistent<v8::FunctionTemplate>::New(tpl); \
	template->InstanceTemplate()->SetInternalFieldCount(2); \
	template->SetClassName(v8::String::NewSymbol(S(type)));
#define GETTER(template, name, fun) template->PrototypeTemplate()->SetAccessor(String::NewSymbol(name), fun);
#define GETTER_SETTER(template, name, get, set) template->PrototypeTemplate()->SetAccessor(String::NewSymbol(name), get, set);
#define SET(target, symbol, object) target->Set(String::NewSymbol(symbol), object)
#define START_INIT(prefix, type) \
  v8::Persistent<v8::FunctionTemplate> prefix::type::wrap_template_; \
  void prefix::type::Init(Handle<Object> target) { \
    CREATE_TEMPLATE(wrap_template_, type)
#define END_INIT(symbol) SET(target, symbol, wrap_template_->GetFunction()); \
	}

#define PROTO_METHOD(target, name, callback) \
    v8::Local<v8::FunctionTemplate> TOKENPASTE2(template, name) = v8::FunctionTemplate::New(callback); \
    target->PrototypeTemplate()->Set(v8::String::NewSymbol(S(name)), TOKENPASTE2(template, name));

#define UNWRAP_EXTERNAL(type, name, arg) \
  CHECK_EXTERNAL(arg) \
  type* name = static_cast<type*>(Handle<External>::Cast(args[arg])->Value())
#define START_NEW(prefix, type, num_args) v8::Handle<v8::Value> prefix::type::New(const v8::Arguments& args) { \
	CHECK_CONSTRUCT(S(type)) \
	HandleScope scope; \
	CHECK_ARGLEN(S(type), num_args);
#define END_NEW return args.This(); \
  }

#define NEW_WRAPPED(pointer, type, ret) \
  v8::Handle<v8::Value> argv[] = {v8::External::New(pointer)}; \
  v8::Handle<v8::Object> ret = type::wrap_template_->GetFunction()->NewInstance(1, argv);


namespace sdl {

  // Error reporting helpers
  v8::Handle<v8::Value> ThrowSDLException(const char* name);
  v8::Local<v8::Value> MakeSDLException(const char* name);

  // Helpers to work with buffers
  char* BufferData(node::Buffer *b);
  size_t BufferLength(node::Buffer *b);
  char* BufferData(v8::Local<v8::Object> buf_obj);
  size_t BufferLength(v8::Local<v8::Object> buf_obj);

  v8::Local<v8::Object> SDLDisplayModeToJavascriptObject(const SDL_DisplayMode& mode);

} // sdl

#endif  // HELPERS_H_
