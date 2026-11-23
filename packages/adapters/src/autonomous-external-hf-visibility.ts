// Hugging Face repository visibility rules for external actions.
// An omitted visibility means private. It is not normalized into the target, because
// normalizing would change every existing profileHash.
export type HfVisibility='private'|'public';

const rejected=()=>new Error('Hugging Face visibility rejected');

export function resolveHfVisibility(value:unknown):HfVisibility{
  if(value===undefined)return 'private';
  if(value==='private'||value==='public')return value;
  throw rejected();
}

/** The repository must report a boolean `private` equal to the expected visibility and must not be disabled. */
export function assertHfVisibility(info:unknown,expected:HfVisibility):void{
  if(info===null||typeof info!=='object'||Array.isArray(info))throw rejected();
  const r=info as Record<string,unknown>;
  if(typeof r.private!=='boolean'||r.disabled===true)throw rejected();
  if(expected!=='private'&&expected!=='public')throw rejected();
  if(r.private!==(expected==='private'))throw rejected();
}

export function hfVisibilityDisplay(target:unknown):{visibility:HfVisibility;publicEffect:boolean;notice:string}{
  const t=target!==null&&typeof target==='object'?target as Record<string,unknown>:{};
  const visibility=resolveHfVisibility(t.visibility);
  if(Object.hasOwn(t,'allowPublicLarge'))assertHfLfsAllowed(t.visibility,t.allowPublicLarge as boolean);
  return visibility==='public'
    ?{visibility,publicEffect:true,notice:'공개 저장소: 이 커밋의 파일은 누구나 읽을 수 있다.'+(t.allowPublicLarge===true?' 공개 대형 게시 허용.':'')}
    :{visibility,publicEffect:false,notice:'비공개 저장소: 이 커밋의 파일은 저장소 접근 권한이 있는 사용자만 읽을 수 있다.'};
}

/** Public large commits require an explicit acknowledgement; legacy omission stays private. */
export function assertHfLfsAllowed(visibility:unknown,allowPublicLarge?:boolean):void{
  const resolved=resolveHfVisibility(visibility);
  if(allowPublicLarge!==undefined&&(allowPublicLarge!==true||resolved!=='public'))throw rejected();
  if(resolved==='public'&&allowPublicLarge!==true)throw rejected();
}
