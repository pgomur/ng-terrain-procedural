# Procedural WebGPU Terrain Engine

An infinite procedural terrain engine using WebGPU compute shaders, predictive spatial streaming, and memory pooling. Built with a reactive architecture (Angular Signals), it orchestrates asynchronous GPU tasks and spatial data structures without blocking the main thread.

## Core Architecture & Engine Design

The engine decouples logical spatial partitioning from actual geometry generation and rendering. The synchronization between state propagation and the render pipeline is resolved via discrete, uni-directional data bindings, allowing the simulation tick to operate deterministically regardless of variable GPU execution times.

### 1. Spatial Partitioning & Predictive Streaming

Terrain is segmented into a continuous logical grid. Rather than a purely reactive culling model, the engine employs a predictive data-streaming layer that preempts geometry generation requirements based on dynamic heuristics.

- **Velocity Extrapolation**: Tracks temporal spatial displacements to derive a camera velocity vector. This vector is applied against candidate terrain sectors using dot-product alignment to score and prioritize geometry intersecting the projected trajectory.
- **Anticipative Buffering**: A pre-allocated ring buffer manages speculative sector requests. If the kinematic model predicts an intersection, the sector is enqueued before entering the visible frustum.
- **Asynchronous Concurrency Throttling**: Limits discrete compute submissions sent to the GPU queue to maintain bandwidth and driver execution budgets, preventing driver timeouts (TDR) and frame drops during high-speed traversal.

### 2. GPU Compute & Geometry Pipeline

Traditional CPU-bound noise permutations are bypassed. The engine delegates procedural elevation sampling and mesh topology directly to the GPU using WebGPU compute pipelines.

- **Compute Dispatch & Evaluation**: Procedural algorithms (Fractional Brownian Motion, fractal warp noise) execute across WebGPU compute shaders.
- **Memory Pooling & Zero-Allocation Staging**: To avoid garbage collection (GC) pauses during chunk generation, the system pools high-level typed arrays, storage buffers, and physical GPU staging buffers.
- **Asynchronous Readback Operations**: Synchronization between the GPU execution domain and the CPU logic domain relies on non-blocking memory-mapped buffer reading (`GPUBuffer.mapAsync`). Raw elevation data is fetched asynchronously to calculate exact AABB bounds on the CPU without stalling the main render loop.

### 3. Analytic Culling & LOD Management

The framework avoids processing or rendering unseen or over-detailed geometry.

- **Analytic Frustum Intersection**: Implements precise testing of generated AABB bounding volumes against dynamically extracted 6-plane camera frustum normals. Only valid volumes are promoted to the rendering stage.
- **Dynamic Level of Detail (LOD)**: Evaluates radial proximity against concentric threshold bounds to downgrade or upgrade sector tessellation resolution.
- **Deferred Graph Mutations**: Mutating the WebGPU scene-graph is inherently expensive. The engine prevents continuous tree reconstruction by calculating transactional diffs between the active logic state and the rendered state, batching structural changes during the synchronization phase.

## Foundation & Compilation

- **Compute & Rendering Layer**: WebGPU implementation via Three.js Shading Language (TSL) that transcodes to optimized WGSL pipelines and utilizes native storage buffers.
- **State Logic**: Reactive state management using Angular Signals isolates component lifecycles, ensuring geometry operations do not trigger cyclical UI re-renders.
- **Mathematical Topologies**: Chunk coordinates, bounding volume intersections, and velocity extrapolations use low-overhead math functions instead of heavily instanced objects.

## Installation & Execution

This environment requires [Node.js](https://nodejs.org/) to run.

1. Install the exact dependencies (NPM is recommended as per the project configuration):

```bash
npm install
```

2. Start the local development server:

```bash
npm start
```

3. Navigate to `http://localhost:4200` in a WebGPU-compatible modern browser
