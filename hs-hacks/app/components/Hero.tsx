'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export default function Hero() {
  const heroRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subtitleRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.fromTo(titleRef.current,
        { opacity: 0, y: 50 },
        { opacity: 1, y: 0, duration: 1, ease: "power2.out" }
      );
      gsap.fromTo(subtitleRef.current,
        { opacity: 0, y: 30 },
        { opacity: 1, y: 0, duration: 1, delay: 0.3, ease: "power2.out" }
      );
    }, heroRef);

    return () => ctx.revert();
  }, []);

  return (
    <section id="hero" ref={heroRef} className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-indigo-900">
      <div className="text-center px-4 max-w-4xl">
        <h1 ref={titleRef} className="text-5xl md:text-7xl font-bold text-gray-800 dark:text-white mb-6">
          Welcome to <span className="text-indigo-600 dark:text-indigo-400">MindWell</span>
        </h1>
        <p ref={subtitleRef} className="text-xl md:text-2xl text-gray-600 dark:text-gray-300 mb-8">
          Your journey to mental wellness starts here. Discover resources, support, and tools for a healthier mind.
        </p>
        <button className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 px-8 rounded-full text-lg transition-colors duration-300">
          Get Started
        </button>
      </div>
    </section>
  );
}