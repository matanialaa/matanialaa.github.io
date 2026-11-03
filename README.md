# matanialaa.github.io

My personal portfolio: a scroll-driven dive through a 3D ocean, from the sunlit surface down to the abyss. On the way down you pass dolphins, a humpback mother and calf, sea turtles, manta rays, fish schools and a sardine bait ball, orca pods, a blue whale, glowing jellyfish and lanternfish.

**Live:** https://matanialaa.github.io

## Built with
- [Three.js](https://github.com/mrdoob/three.js) r160: every creature is built in code. Bodies come from spline-profile lathes, markings (orca patches, turtle scutes, manta chevrons) are painted per pixel in shaders, and swimming is a vertex-shader cycle. Fish schools are instanced. The scene also has caustic light, god rays, particles and UnrealBloom glow.
- [GSAP](https://github.com/greensock/GSAP) 3.12 + ScrollTrigger: reveal animations
- Plain HTML/CSS/JS, no build step. Libraries are vendored in `vendor/`.

## Run locally
```bash
python3 -m http.server 8000
```
Then open http://localhost:8000.

## Testing flags
Add these to the URL: `?instant` (the camera follows scroll with no easing), `?nobloom` (turns off the glow pass), `?cam=x,y,z,lx,ly,lz` (fixed camera position and look-at point).

## Editing content
All text lives in `index.html`. The ocean scene, including the creatures' positions and depths, is in `ocean.js`.
