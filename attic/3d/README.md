# Parked: the 3D wall and iPhone LiDAR

Set aside until the video analysis is solid. To bring it back:

1. Move `Scan3D.tsx` to `src/components/` and `cloud.ts` to `src/lib/`.
2. `npm install three @react-three/fiber @react-three/drei` and `npm install -D @types/three`,
   and add them back to `optimizeDeps.include` in `vite.config.ts`.
3. Restore the `scan` tab in `src/views/SessionView.tsx` and the `.scan-*`, `.labels3d`,
   `.label3d`, `.badge3d`, `.tag3d`, `.cam-modes` and `.metric` rules in `src/styles.css`
   (all in commit 7243659).
4. `Session.lidar` and the `.ply` import (same commit) carry a `wall.ply` from
   `vision-demos/rock_climbing_3d` into the cloud.
