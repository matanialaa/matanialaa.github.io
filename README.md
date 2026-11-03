# matanialaa.github.io

My personal portfolio: a scroll-driven dive through a 3D ocean, from the sunlit surface down to the abyss, with humpbacks, a blue whale and orca pods swimming past my projects.

**Live:** https://matanialaa.github.io

## Built with
- [Three.js](https://github.com/mrdoob/three.js) r160: procedural whales and orcas (lathe + extruded fins, a vertex-shader swim cycle), caustics, god rays and particle shaders
- [GSAP](https://github.com/greensock/GSAP) 3.12 + ScrollTrigger: reveal animations
- Plain HTML/CSS/JS, no build step. Libraries are vendored in `vendor/`.

## Run locally
```bash
python3 -m http.server 8000
```
Then open http://localhost:8000.

## Editing content
All text lives in `index.html`. The ocean scene, including the creatures' positions and depths, is in `ocean.js`.
