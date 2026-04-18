'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const issues = [
  {
    title: "Anxiety Disorders",
    description: "Characterized by excessive worry and fear that can interfere with daily activities.",
    color: "from-yellow-100 to-orange-100 dark:from-yellow-900 dark:to-orange-900"
  },
  {
    title: "Depression",
    description: "A mood disorder involving persistent feelings of sadness and loss of interest.",
    color: "from-blue-100 to-indigo-100 dark:from-blue-900 dark:to-indigo-900"
  },
  {
    title: "PTSD",
    description: "Post-traumatic stress disorder can develop after experiencing or witnessing a traumatic event.",
    color: "from-red-100 to-pink-100 dark:from-red-900 dark:to-pink-900"
  },
  {
    title: "Eating Disorders",
    description: "Serious conditions characterized by abnormal eating habits that can threaten health.",
    color: "from-green-100 to-teal-100 dark:from-green-900 dark:to-teal-900"
  },
  {
    title: "Bipolar Disorder",
    description: "A mental health condition that causes extreme mood swings including emotional highs and lows.",
    color: "from-purple-100 to-indigo-100 dark:from-purple-900 dark:to-indigo-900"
  },
  {
    title: "Schizophrenia",
    description: "A chronic mental disorder involving distortions in thinking, perception, emotions, and behavior.",
    color: "from-gray-100 to-slate-100 dark:from-gray-900 dark:to-slate-900"
  }
];

export default function CommonIssues() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement[]>([]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      cardsRef.current.forEach((card, index) => {
        gsap.fromTo(card,
          { opacity: 0, y: 50 },
          {
            opacity: 1,
            y: 0,
            duration: 0.8,
            delay: index * 0.1,
            scrollTrigger: {
              trigger: card,
              start: "top 85%",
              toggleActions: "play none none reverse"
            }
          }
        );
      });
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section id="issues" ref={sectionRef} className="py-20 px-4 bg-gray-50 dark:bg-gray-900">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-4xl font-bold text-center text-gray-800 dark:text-white mb-12">
          Common Mental Health Issues
        </h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {issues.map((issue, index) => (
            <div
              key={issue.title}
              ref={(el) => { if (el) cardsRef.current[index] = el; }}
              className={`bg-gradient-to-br ${issue.color} p-6 rounded-2xl shadow-lg hover:shadow-xl transition-shadow duration-300`}
            >
              <h3 className="text-xl font-semibold text-gray-800 dark:text-white mb-3">
                {issue.title}
              </h3>
              <p className="text-gray-700 dark:text-gray-300">
                {issue.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}