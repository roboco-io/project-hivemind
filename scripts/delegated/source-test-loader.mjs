// Development-only source tests: production TypeScript emits .js specifiers.
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('.')&&specifier.endsWith('.js')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
  if(existsSync(source))return next(source.href,context);
 }
 return next(specifier,context);
}});
