// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 takboo. API 2 example using Coopanion's shared body kit.
export async function createStarBody(base, { kit, host, scheme }) {
  const ns = 'http://www.w3.org/2000/svg';
  const make = (tag, attributes) => {
    const el = host.root.ownerDocument.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
    return el;
  };
  const star = make('polygon', { points: '128,20 158,84 228,95 177,148 188,220 128,185 68,220 79,148 28,95 98,84', stroke: '#624c30', 'stroke-width': 5, 'stroke-linejoin': 'round' });
  const eyes = [make('ellipse', { cx: 102, cy: 112, rx: 7, ry: 11 }), make('ellipse', { cx: 150, cy: 112, rx: 7, ry: 11 })];
  const mouth = make('path', { stroke: '#624c30', 'stroke-width': 4, 'stroke-linecap': 'round', fill: 'none' });
  let colour = scheme;
  const figure = {
    extent: [25, 20, 232, 242], hits: [[128, 125, 95]], anchors: { gaze: [128, 112], bubble: [128, 16] }, colors: { z: '#ad7418' },
    draw(group, face, frame) {
      if (star.parentNode !== group) group.append(star, ...eyes, mouth);
      star.setAttribute('fill', colour === 'night' ? '#8ab6e8' : '#ffdc74');
      star.setAttribute('transform', `rotate(${Math.sin(frame.t * 2) * 2} 128 128)`);
      for (const [i, eye] of eyes.entries()) {
        eye.setAttribute('cx', String((i ? 150 : 102) + frame.look[0]));
        eye.setAttribute('ry', String(Math.max(1, 11 * (1 - frame.blink))));
        eye.setAttribute('fill', '#624c30');
      }
      mouth.setAttribute('d', `M114 139 Q128 ${frame.face === 'sad' ? 125 : 151 + frame.talk * 18} 142 139`);
      group.dataset.mode = frame.mode; group.dataset.face = frame.face; group.dataset.talk = String(frame.talk);
    },
    setScheme(id) { colour = id; },
  };
  return kit.createBody(host, { figure, roam: 'off' });
}
