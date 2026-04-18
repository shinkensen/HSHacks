'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export default function About() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.fromTo(contentRef.current,
        { opacity: 0, x: -100 },
        {
          opacity: 1,
          x: 0,
          duration: 1,
          scrollTrigger: {
            trigger: sectionRef.current,
            start: "top 80%",
            end: "bottom 20%",
            toggleActions: "play none none reverse"
          }
        }
      );
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section id="about" ref={sectionRef} className="py-20 px-4 bg-white dark:bg-gray-800">
      <div className="max-w-6xl mx-auto">
        <div ref={contentRef} className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-4xl font-bold text-gray-800 dark:text-white mb-6">
              What is Mental Health?
            </h2>
            <p className="text-lg text-gray-600 dark:text-gray-300 mb-6">
              Mental health includes our emotional, psychological, and social well-being. It affects how we think, feel, and act. It also helps determine how we handle stress, relate to others, and make choices.
            </p>
            <p className="text-lg text-gray-600 dark:text-gray-300">
              Mental health is important at every stage of life, from childhood and adolescence through adulthood. Over the course of your life, if you experience mental health problems, your thinking, mood, and behavior could be affected.
            </p>
          </div>
          <div className="bg-gradient-to-br from-indigo-100 to-purple-100 dark:from-indigo-900 dark:to-purple-900 p-8 rounded-2xl">
            <h3 className="text-2xl font-semibold text-gray-800 dark:text-white mb-4">
              Key Aspects
            </h3>
            <ul className="space-y-3 text-gray-700 dark:text-gray-300">
              <li>• Emotional well-being</li>
              <li>• Psychological resilience</li>
              <li>• Social connections</li>
              <li>• Cognitive functioning</li>
              <li>• Behavioral health</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}