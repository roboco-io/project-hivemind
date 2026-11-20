// Counters classified as uncacheable by ccache 4.14.3.
const uncacheableCounters=[
 'autoconf_test','bad_compiler_arguments','called_for_link','called_for_preprocessing','compile_failed',
 'compiler_produced_no_output','compiler_produced_empty_output','compiler_produced_stdout',
 'could_not_use_modules','could_not_use_precompiled_header','disabled','multiple_source_files',
 'no_input_file','output_to_stdout','preprocessor_error','recache','unsupported_code_directive',
 'unsupported_compiler_option','unsupported_environment_variable','unsupported_source_encoding','unsupported_source_language',
];

export function parseCacheStats(text:string){
 const counters=JSON.parse(text);
 const count=(name:string)=>{
  const value=counters?.[name];
  if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid ccache statistics');
  return value;
 };
 const directHits=count('direct_cache_hit'),preprocessedHits=count('preprocessed_cache_hit');
 const misses=count('cache_miss'),filesInCache=count('files_in_cache'),sizeKiB=count('cache_size_kibibyte');
 const uncacheable=uncacheableCounters.reduce((total,name)=>total+(Object.hasOwn(counters,name)?count(name):0),0);
 const cleanups=Object.hasOwn(counters,'cleanups_performed')?count('cleanups_performed'):0;
 return {version:'4.14.3',hits:directHits+preprocessedHits,directHits,preprocessedHits,misses,uncacheable,filesInCache,sizeKiB,cleanups};
}
