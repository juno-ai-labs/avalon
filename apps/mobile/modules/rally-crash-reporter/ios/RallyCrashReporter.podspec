Pod::Spec.new do |s|
  s.name           = 'RallyCrashReporter'
  s.version        = '1.0.0'
  s.summary        = 'Regional iOS crash capture'
  s.description    = 'Local crash capture for the Rally regional collector.'
  s.author         = 'Juno AI Labs'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'PLCrashReporter', '1.12.0'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
