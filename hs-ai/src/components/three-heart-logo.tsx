"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { gsap } from "gsap";

import { cn } from "@/lib/utils";

const CUBE_SIZE = 30;
const OFFSET = 35;
const CAMERA_DISTANCE_Z = 560;
const CAMERA_DISTANCE_Y = 150;
const BASE_COLOR = 0xe31749;
const ALT_COLOR = 0xf22c5d;

function createLevels(heart: THREE.Group, geometry: THREE.BoxGeometry) {
  const cubes: THREE.Mesh[] = [];
  const groups: THREE.Group[] = [];
  const materials: THREE.MeshPhongMaterial[] = [];
  const levels = [
    { level: 0, lineCount: 1, excludeCenter: false },
    { level: 1, lineCount: 3, excludeCenter: false },
    { level: 2, lineCount: 5, excludeCenter: false },
    { level: 3, lineCount: 7, excludeCenter: false },
    { level: 4, lineCount: 7, excludeCenter: false },
    { level: 5, lineCount: 5, excludeCenter: true },
  ];

  for (const { level, lineCount, excludeCenter } of levels) {
    const group = new THREE.Group();
    group.userData.level = level;
    group.position.y = -100 + OFFSET * level;
    heart.add(group);
    groups.push(group);

    let x = -OFFSET * Math.floor(lineCount / 2);
    for (let i = 0; i < lineCount; i += 1) {
      if (excludeCenter && i === Math.floor(lineCount / 2)) {
        x += OFFSET;
        continue;
      }

      const material = new THREE.MeshPhongMaterial({
        color: level % 2 ? ALT_COLOR : BASE_COLOR,
      });
      materials.push(material);

      const cube0 = new THREE.Mesh(geometry, material);
      const cube1 = new THREE.Mesh(geometry, material);
      cube0.position.set(x, 0, OFFSET / 2);
      cube1.position.set(x, 0, -OFFSET / 2);
      group.add(cube0);
      group.add(cube1);
      cubes.push(cube0, cube1);
      x += OFFSET;
    }
  }

  return { cubes, groups, materials };
}

export function ThreeHeartLogo({ className }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 2000);
    camera.position.y = CAMERA_DISTANCE_Y;
    camera.position.z = CAMERA_DISTANCE_Z;
    camera.lookAt(scene.position);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    mount.appendChild(renderer.domElement);

    const lightA = new THREE.DirectionalLight(0xffffff, 1.15);
    lightA.position.set(-100, 100, 200);
    scene.add(lightA);

    const lightB = new THREE.DirectionalLight(0xffffff, 1.15);
    lightB.position.set(100, 100, 200);
    scene.add(lightB);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);

    const fillLight = new THREE.PointLight(0xffffff, 1.25, 2200);
    fillLight.position.set(0, 120, 280);
    scene.add(fillLight);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x441122, 0.42);
    scene.add(hemi);

    const backLight = new THREE.PointLight(0xffdbe5, 0.95, 2000);
    backLight.position.set(0, -80, -260);
    scene.add(backLight);

    const geometry = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
    const heart = new THREE.Group();
    heart.scale.setScalar(1.14);
    scene.add(heart);

    const { cubes, groups, materials } = createLevels(heart, geometry);

    const fitTimeline = gsap.timeline();
    const widthRef = { value: mount.clientWidth || 280 };
    const heightRef = { value: mount.clientHeight || 280 };
    for (const cube of cubes) {
      const target = cube.position.clone();
      // Spawn from a bounded 3D shell around center so cubes don't look edge-clipped.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const spawnRadius = THREE.MathUtils.clamp(
        Math.min(widthRef.value, heightRef.value) * 0.42,
        150,
        235,
      );
      const radius = spawnRadius * (0.82 + Math.random() * 0.36);
      cube.position.set(
        Math.sin(phi) * Math.cos(theta) * radius * 0.9,
        Math.cos(phi) * radius * 0.74,
        Math.sin(phi) * Math.sin(theta) * radius * 0.5,
      );
      fitTimeline.to(
        cube.position,
        {
          duration: 2,
          x: target.x,
          y: target.y,
          z: target.z,
          ease: "expo.inOut",
        },
        0,
      );
    }

    const rotateTimeline = gsap.timeline({
      repeat: -1,
      repeatDelay: 2,
      delay: 2,
    });
    for (const group of groups) {
      const level = Number(group.userData.level ?? 0);
      rotateTimeline
        .to(group.rotation, { duration: 0.4, y: -0.2 }, 0)
        .to(
          group.rotation,
          { duration: 2, y: Math.PI * 2, ease: "expo.inOut" },
          1.4 - 0.2 * level,
        );
    }

    let frame = 0;
    const render = () => {
      renderer.render(scene, camera);
      frame = window.requestAnimationFrame(render);
    };

    const resize = () => {
      const width = mount.clientWidth || 1;
      const height = mount.clientHeight || 1;
      widthRef.value = width;
      heightRef.value = height;
      renderer.setSize(width, height, true);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    resize();
    render();

    const observer = new ResizeObserver(() => resize());
    observer.observe(mount);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      fitTimeline.kill();
      rotateTimeline.kill();
      for (const cube of cubes) {
        (cube.material as THREE.Material).dispose();
      }
      for (const material of materials) {
        material.dispose();
      }
      geometry.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div
      ref={mountRef}
      className={cn(
        "relative h-[20rem] w-[min(96vw,42rem)] sm:h-[24rem] sm:w-[min(92vw,48rem)]",
        className,
      )}
      role="img"
      aria-label="momentum.ai 3D heart logo"
    />
  );
}
