export const npmCacheOrigin='https://hivemind-npm-cache.invalid';
export const npmCacheMaxBytes=90*1024*1024;
export const npmCacheLockPath='benchmark-lock/package-lock.json';
export const npmCachePath='/v1/archive';
export const npmCacheKey=(lockSha256:string)=>'npm-cache/v1/linux-x64-node24.14.0-npm11.9.0/'+lockSha256;
