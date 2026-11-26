import test from 'node:test';
import assert from 'node:assert/strict';
import {assertHfLfsAllowed,assertHfVisibility,hfVisibilityDisplay,resolveHfVisibility} from '../packages/adapters/src/autonomous-external-hf-visibility.ts';

test('visibility: undefined means private, anything else must match exactly',()=>{
  assert.equal(resolveHfVisibility(undefined),'private');
  assert.equal(resolveHfVisibility('private'),'private');
  assert.equal(resolveHfVisibility('public'),'public');
  for(const bad of ['Public','PRIVATE','',null,true,1,{}])assert.throws(()=>resolveHfVisibility(bad));
});

test('visibility: repository info must match the expected visibility',()=>{
  assertHfVisibility({private:true},'private');
  assertHfVisibility({private:false},'public');
  assert.throws(()=>assertHfVisibility({private:true},'public'));
  assert.throws(()=>assertHfVisibility({private:false},'private'));
  assert.throws(()=>assertHfVisibility({private:'false'},'public'));
  assert.throws(()=>assertHfVisibility({private:'true'},'private'));
  assert.throws(()=>assertHfVisibility({},'private'));
  assert.throws(()=>assertHfVisibility(null,'private'));
  assert.throws(()=>assertHfVisibility([],'private'));
  assert.throws(()=>assertHfVisibility({private:false,disabled:true},'public'));
  assertHfVisibility({private:false,disabled:false},'public');
});

test('visibility: display marks public effect',()=>{
  const priv=hfVisibilityDisplay({repository:'o/r'});
  assert.equal(priv.visibility,'private');assert.equal(priv.publicEffect,false);
  const pub=hfVisibilityDisplay({repository:'o/r',visibility:'public'});
  assert.equal(pub.visibility,'public');assert.equal(pub.publicEffect,true);
  assert.ok(pub.notice.length>0&&pub.notice!==priv.notice);
  assert.throws(()=>hfVisibilityDisplay({visibility:'Public'}));
});

test('visibility: lfs_commit is denied on public profiles',()=>{
  assertHfLfsAllowed('private');
  assert.throws(()=>assertHfLfsAllowed('public'));
  assert.throws(()=>assertHfLfsAllowed('x'));
});

test('visibility: public large requires exact opt-in and private rejects stray flags',()=>{
  assertHfLfsAllowed(undefined);
  assertHfLfsAllowed('public',true);
  for(const flag of [false,null,'true',1,{}])assert.throws(()=>assertHfLfsAllowed('public',flag as never));
  for(const visibility of [undefined,'private'])assert.throws(()=>assertHfLfsAllowed(visibility,true));
});

test('visibility: public large display explicitly names the acknowledged effect',()=>{
 const display=hfVisibilityDisplay({visibility:'public',allowPublicLarge:true});
 assert.equal(display.publicEffect,true);assert.match(display.notice,/공개 대형 게시 허용/);
 for(const target of [{visibility:'public',allowPublicLarge:'true'},{visibility:'private',allowPublicLarge:true}])assert.throws(()=>hfVisibilityDisplay(target));
});
