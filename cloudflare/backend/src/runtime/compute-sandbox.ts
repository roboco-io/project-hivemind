/** Compute has no model credentials; the outer backend still controls destinations. */
export function computeSandboxArgs():string[] {
 return ['codex','sandbox','-c','permissions.checks={extends=":workspace",network={enabled=true}}','-P','checks','--'];
}
