import assert from 'node:assert/strict';
import { nativeClick } from './native-pointer.mjs';

// Used by both the source desktop test and the two officially installed hosts.
export async function sampleNativeDisplay(page, selector = '#message') {
  const native = await nativeClick(page, selector);
  const renderer = await page.locator(selector).evaluate(el => {
    const b=el.getBoundingClientRect(), pet=document.querySelector('#pet').getBoundingClientRect();
    return {viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,screen:{x:screenX,y:screenY},
      hit:{x:b.x,y:b.y,width:b.width,height:b.height},pet:{x:pet.x,y:pet.y,width:pet.width,height:pet.height},focused:el===document.activeElement};
  });
  assert.ok(native.geometry,'native geometry was initialized');
  assert.deepEqual(native.contentBounds,native.geometry.contentBounds);
  assert.equal(renderer.viewport.width,native.contentBounds.width); assert.equal(renderer.viewport.height,native.contentBounds.height);
  assert.ok(renderer.hit.x>=0&&renderer.hit.y>=0&&renderer.hit.x+renderer.hit.width<=renderer.viewport.width&&renderer.hit.y+renderer.hit.height<=renderer.viewport.height);
  const d=native.displays.find(d=>d.id===native.geometry.displayId); assert.ok(d);
  assert.deepEqual(native.contentBounds,d.workArea,'native window occupies one actual work area');
  return {native,renderer,osCursorAndCdpClick:true};
}
