'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const tips = [
  {
    title: "Practice Mindfulness",
    description: "Take time each day to focus on the present moment. Meditation apps or simple breathing exercises can help.",
    icon: "🧘"
  },
  {
    title: "Stay Connected",
    description: "Maintain relationships with friends and family. Social support is crucial for mental health.",
    icon: "🤝"
  },
  {
    title: "Exercise Regularly",
    description: "Physical activity releases endorphins that can improve mood and reduce stress.",
    icon: "🏃"
  },
  {
    title: "Get Enough Sleep",
    description: "Aim for 7-9 hours of quality sleep per night. Poor sleep can worsen mental health issues.",
    icon: "😴"
  },
  {
    title: "Eat Well",
    description: "A balanced diet supports brain health. Include fruits, vegetables, whole grains, and lean proteins.",
    icon: "🥗"
  },
  {
    title: "Seek Professional Help",
    description: "If you're struggling, don't hesitate to talk to a mental health professional. It's a sign of strength.",
    icon: "💬"
  }
];

export default function Tips() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const tipsRef = useRef<HTMLDivElement[]>([]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      tipsRef.current.forEach((tip, index) => {
        gsap.fromTo(tip,
          { opacity: 0, y: 100, scale: 0.8 },
          {
            opacity: 1,
            y: 0,
            scale: 1,
            duration: 0.8,
            delay: index * 0.15,
            ease: "back.out(1.7)",
            scrollTrigger: {
              trigger: tip,
              start: "top 90%",
              toggleActions: "play none none reverse"
            }
          }
        );
      });
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section id="tips" ref={sectionRef} className="py-20 px-4 bg-gradient-to-br from-green-50 to-blue-50 dark:from-green-900 dark:to-blue-900">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-4xl font-bold text-center text-gray-800 dark:text-white mb-12">
          Daily Wellness Tips
        </h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {tips.map((tip, index) => (
            <div
              key={tip.title}
              ref={(el) => { if (el) tipsRef.current[index] = el; }}
              className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-lg hover:shadow-xl transition-all duration-300"
            >
              <div className="text-4xl mb-4">{tip.icon}</div>
              <h3 className="text-xl font-semibold text-gray-800 dark:text-white mb-3">
                {tip.title}
              </h3>
              <p className="text-gray-600 dark:text-gray-300">
                {tip.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}