#include <node_api.h>

#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace {

constexpr AudioObjectPropertyAddress PropertyAddress(
    AudioObjectPropertySelector selector,
    AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal,
    AudioObjectPropertyElement element = kAudioObjectPropertyElementMain) noexcept {
  return {selector, scope, element};
}

struct AudioChunk {
  std::vector<float> samples;
  double sampleRate = 0;
  bool endOfStream = false;
};

std::mutex captureMutex;
std::atomic<bool> captureRunning{false};
std::atomic<napi_threadsafe_function> audioThreadsafeFunction{nullptr};
AudioObjectID tapID = kAudioObjectUnknown;
AudioObjectID aggregateDeviceID = kAudioObjectUnknown;
AudioDeviceIOProcID ioProcID = nullptr;
AudioStreamBasicDescription tapFormat{};

std::string FourCharacterCode(OSStatus status) {
  const auto value = static_cast<uint32_t>(status);
  char code[5] = {
      static_cast<char>((value >> 24) & 0xff),
      static_cast<char>((value >> 16) & 0xff),
      static_cast<char>((value >> 8) & 0xff),
      static_cast<char>(value & 0xff),
      '\0',
  };
  for (size_t index = 0; index < 4; index += 1) {
    if (code[index] < 0x20 || code[index] > 0x7e) code[index] = '?';
  }
  return std::string(code, 4);
}

std::string StatusMessage(const char* operation, OSStatus status) {
  if (status == kAudioDevicePermissionsError) {
    return "Computer audio access is blocked. Allow Rally in System Settings > Privacy & Security > Screen & System Audio Recording, under System Audio Recording Only, then try again.";
  }
  return std::string(operation) + " failed (Core Audio " + FourCharacterCode(status)
      + ", " + std::to_string(status) + ").";
}

void ThrowError(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

void CallJavaScript(
    napi_env env,
    napi_value callback,
    void*,
    void* rawChunk) {
  auto* chunk = static_cast<AudioChunk*>(rawChunk);
  if (chunk == nullptr) return;
  if (env == nullptr || callback == nullptr) {
    delete chunk;
    return;
  }

  if (chunk->endOfStream) {
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, callback, 0, nullptr, nullptr);
    delete chunk;
    return;
  }

  napi_value buffer;
  void* copiedData = nullptr;
  const size_t byteLength = chunk->samples.size() * sizeof(float);
  napi_status status = napi_create_buffer_copy(
      env,
      byteLength,
      chunk->samples.data(),
      &copiedData,
      &buffer);
  if (status != napi_ok) {
    delete chunk;
    return;
  }
  napi_value sampleRate;
  status = napi_create_double(env, chunk->sampleRate, &sampleRate);
  if (status == napi_ok) {
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    napi_value arguments[] = {buffer, sampleRate};
    napi_call_function(env, undefined, callback, 2, arguments, nullptr);
  }
  delete chunk;
}

OSStatus CaptureIOProc(
    AudioObjectID,
    const AudioTimeStamp*,
    const AudioBufferList* inputData,
    const AudioTimeStamp*,
    AudioBufferList*,
    const AudioTimeStamp*,
    void*) noexcept {
  if (!captureRunning.load(std::memory_order_acquire) || inputData == nullptr
      || inputData->mNumberBuffers == 0) {
    return kAudioHardwareNoError;
  }
  const auto threadsafeFunction = audioThreadsafeFunction.load(std::memory_order_acquire);
  if (threadsafeFunction == nullptr) return kAudioHardwareNoError;
  if (tapFormat.mFormatID != kAudioFormatLinearPCM
      || (tapFormat.mFormatFlags & kAudioFormatFlagIsFloat) == 0
      || tapFormat.mBitsPerChannel != 32) {
    return kAudioHardwareUnsupportedOperationError;
  }

  const AudioBuffer& firstBuffer = inputData->mBuffers[0];
  if (firstBuffer.mData == nullptr || firstBuffer.mNumberChannels == 0) {
    return kAudioHardwareNoError;
  }
  const UInt32 frameCount = firstBuffer.mDataByteSize
      / (static_cast<UInt32>(sizeof(float)) * firstBuffer.mNumberChannels);
  if (frameCount == 0) return kAudioHardwareNoError;

  auto* chunk = new AudioChunk();
  chunk->sampleRate = tapFormat.mSampleRate;
  chunk->samples.resize(frameCount);
  for (UInt32 frame = 0; frame < frameCount; frame += 1) {
    double sum = 0;
    UInt32 channelCount = 0;
    for (UInt32 bufferIndex = 0; bufferIndex < inputData->mNumberBuffers; bufferIndex += 1) {
      const AudioBuffer& buffer = inputData->mBuffers[bufferIndex];
      if (buffer.mData == nullptr || buffer.mNumberChannels == 0) continue;
      const auto* samples = static_cast<const float*>(buffer.mData);
      for (UInt32 channel = 0; channel < buffer.mNumberChannels; channel += 1) {
        const float sample = samples[(frame * buffer.mNumberChannels) + channel];
        if (std::isfinite(sample)) sum += sample;
        channelCount += 1;
      }
    }
    chunk->samples[frame] = channelCount == 0
        ? 0
        : static_cast<float>(std::clamp(sum / channelCount, -1.0, 1.0));
  }

  const napi_status queued = napi_call_threadsafe_function(
      threadsafeFunction,
      chunk,
      napi_tsfn_nonblocking);
  if (queued != napi_ok) delete chunk;
  return kAudioHardwareNoError;
}

bool ReleaseThreadsafeFunction(bool drain) {
  const auto threadsafeFunction = audioThreadsafeFunction.exchange(
      nullptr,
      std::memory_order_acq_rel);
  bool drainQueued = true;
  if (threadsafeFunction != nullptr) {
    if (drain) {
      auto* endOfStream = new AudioChunk();
      endOfStream->endOfStream = true;
      const napi_status queued = napi_call_threadsafe_function(
          threadsafeFunction,
          endOfStream,
          napi_tsfn_blocking);
      if (queued != napi_ok) {
        delete endOfStream;
        drainQueued = false;
      }
    }
    napi_release_threadsafe_function(
        threadsafeFunction,
        drain ? napi_tsfn_release : napi_tsfn_abort);
  }
  return drainQueued;
}

bool StopCaptureLocked(bool drain) {
  captureRunning.store(false, std::memory_order_release);
  if (aggregateDeviceID != kAudioObjectUnknown && ioProcID != nullptr) {
    AudioDeviceStop(aggregateDeviceID, ioProcID);
    AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID);
  }
  ioProcID = nullptr;
  if (aggregateDeviceID != kAudioObjectUnknown) {
    AudioHardwareDestroyAggregateDevice(aggregateDeviceID);
    aggregateDeviceID = kAudioObjectUnknown;
  }
  if (tapID != kAudioObjectUnknown) {
    if (@available(macOS 14.2, *)) AudioHardwareDestroyProcessTap(tapID);
    tapID = kAudioObjectUnknown;
  }
  tapFormat = {};
  return ReleaseThreadsafeFunction(drain);
}

OSStatus GetTapProperty(
    AudioObjectPropertySelector selector,
    void* value,
    UInt32* valueSize) {
  auto address = PropertyAddress(selector);
  return AudioObjectGetPropertyData(tapID, &address, 0, nullptr, valueSize, value);
}

OSStatus StartCoreAudioTap() API_AVAILABLE(macos(14.2)) {
  @autoreleasepool {
    CATapDescription* description = [[CATapDescription alloc]
        initStereoGlobalTapButExcludeProcesses:@[]];
    description.name = @"Rally Meeting System Audio";
    description.privateTap = YES;
    description.muteBehavior = CATapUnmuted;

    OSStatus status = AudioHardwareCreateProcessTap(description, &tapID);
    if (status != kAudioHardwareNoError) return status;

    CFStringRef rawTapUID = nullptr;
    UInt32 tapUIDSize = sizeof(rawTapUID);
    status = GetTapProperty(kAudioTapPropertyUID, &rawTapUID, &tapUIDSize);
    if (status != kAudioHardwareNoError || rawTapUID == nullptr) {
      if (rawTapUID != nullptr) CFRelease(rawTapUID);
      return status == kAudioHardwareNoError ? kAudioHardwareUnspecifiedError : status;
    }
    NSString* tapUID = CFBridgingRelease(rawTapUID);

    UInt32 formatSize = sizeof(tapFormat);
    status = GetTapProperty(kAudioTapPropertyFormat, &tapFormat, &formatSize);
    if (status != kAudioHardwareNoError) return status;
    if (tapFormat.mFormatID != kAudioFormatLinearPCM
        || (tapFormat.mFormatFlags & kAudioFormatFlagIsFloat) == 0
        || tapFormat.mBitsPerChannel != 32
        || tapFormat.mSampleRate <= 0) {
      return kAudioHardwareUnsupportedOperationError;
    }

    NSString* aggregateUID = [NSString stringWithFormat:@"ai.rallywith.desktop.system-audio.%@",
                                                        NSUUID.UUID.UUIDString];
    NSDictionary* tapEntry = @{
      @(kAudioSubTapUIDKey): tapUID,
      @(kAudioSubTapDriftCompensationKey): @YES,
    };
    NSDictionary* aggregateDescription = @{
      @(kAudioAggregateDeviceNameKey): @"Rally Meeting System Audio",
      @(kAudioAggregateDeviceUIDKey): aggregateUID,
      @(kAudioAggregateDeviceTapListKey): @[tapEntry],
      @(kAudioAggregateDeviceIsPrivateKey): @YES,
    };
    status = AudioHardwareCreateAggregateDevice(
        (__bridge CFDictionaryRef)aggregateDescription,
        &aggregateDeviceID);
    if (status != kAudioHardwareNoError) return status;

    status = AudioDeviceCreateIOProcID(
        aggregateDeviceID,
        CaptureIOProc,
        nullptr,
        &ioProcID);
    if (status != kAudioHardwareNoError) return status;

    captureRunning.store(true, std::memory_order_release);
    status = AudioDeviceStart(aggregateDeviceID, ioProcID);
    if (status != kAudioHardwareNoError) {
      captureRunning.store(false, std::memory_order_release);
    }
    return status;
  }
}

napi_value IsSupported(napi_env env, napi_callback_info) {
  napi_value result;
  bool supported = false;
  if (@available(macOS 14.2, *)) supported = true;
  napi_get_boolean(env, supported, &result);
  return result;
}

napi_value Start(napi_env env, napi_callback_info info) {
  std::lock_guard<std::mutex> guard(captureMutex);
  if (captureRunning.load(std::memory_order_acquire)) {
    ThrowError(env, "Computer audio capture is already active.");
    return nullptr;
  }
  bool supported = false;
  if (@available(macOS 14.2, *)) supported = true;
  if (!supported) {
    ThrowError(env, "Computer audio recording requires macOS 14.2 or later.");
    return nullptr;
  }

  size_t argumentCount = 1;
  napi_value arguments[1];
  napi_get_cb_info(env, info, &argumentCount, arguments, nullptr, nullptr);
  napi_valuetype callbackType = napi_undefined;
  if (argumentCount != 1
      || napi_typeof(env, arguments[0], &callbackType) != napi_ok
      || callbackType != napi_function) {
    ThrowError(env, "Computer audio capture requires an audio callback.");
    return nullptr;
  }

  napi_value resourceName;
  napi_create_string_utf8(
      env,
      "RallySystemAudio",
      NAPI_AUTO_LENGTH,
      &resourceName);
  napi_threadsafe_function threadsafeFunction = nullptr;
  const napi_status createStatus = napi_create_threadsafe_function(
      env,
      arguments[0],
      nullptr,
      resourceName,
      0,
      1,
      nullptr,
      nullptr,
      nullptr,
      CallJavaScript,
      &threadsafeFunction);
  if (createStatus != napi_ok) {
    ThrowError(env, "Rally could not initialize its computer audio callback.");
    return nullptr;
  }
  audioThreadsafeFunction.store(threadsafeFunction, std::memory_order_release);

  OSStatus status = kAudioHardwareUnsupportedOperationError;
  if (@available(macOS 14.2, *)) status = StartCoreAudioTap();
  if (status != kAudioHardwareNoError) {
    const std::string message = StatusMessage("Starting computer audio", status);
    StopCaptureLocked(false);
    ThrowError(env, message);
    return nullptr;
  }

  napi_value result;
  napi_create_object(env, &result);
  napi_value sampleRate;
  napi_create_double(env, tapFormat.mSampleRate, &sampleRate);
  napi_set_named_property(env, result, "sampleRate", sampleRate);
  napi_value channels;
  napi_create_uint32(env, 1, &channels);
  napi_set_named_property(env, result, "channels", channels);
  return result;
}

napi_value Stop(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> guard(captureMutex);
  if (!StopCaptureLocked(true)) {
    ThrowError(env, "Rally could not drain the final computer-audio samples.");
    return nullptr;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

void Cleanup(void*) {
  std::lock_guard<std::mutex> guard(captureMutex);
  StopCaptureLocked(false);
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"isSupported", nullptr, IsSupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(
      env,
      exports,
      sizeof(properties) / sizeof(properties[0]),
      properties);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
