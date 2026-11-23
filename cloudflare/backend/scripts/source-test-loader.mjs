// Test-only resolution for workspace sources that use emitted .js specifiers.
// Existing JavaScript and dependency resolution always take precedence.
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {relative,isAbsolute,sep} from 'node:path';
const repository=fileURLToPath(new URL('../../../',import.meta.url));
registerHooks({resolve(specifier,context,next){
 try{return next(specifier,context);}catch(error){
  if(error.code!=='ERR_MODULE_NOT_FOUND'||!specifier.startsWith('.')||!specifier.endsWith('.js')||!context.parentURL?.startsWith('file:'))throw error;
  const target=new URL(specifier,context.parentURL),path=relative(repository,fileURLToPath(target));
  if(isAbsolute(path)||path==='..'||path.startsWith('..'+sep)||path.split(sep).includes('node_modules'))throw error;
  return next(new URL(specifier.slice(0,-3)+'.ts',context.parentURL).href,context);
 }
}});
