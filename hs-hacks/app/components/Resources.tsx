'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const resources = [
  {
    title: "National Alliance on Mental Illness (NAMI)",
    description: "Support, education, and advocacy for people with mental illness.",
    link: "https://www.nami.org",
    type: "Organization"
  },
  {
    title: "Mental Health America",
    description: "Works to promote mental health as a critical part of overall wellness.",
    link: "https://www.mhanational.org",
    type: "Organization"
  },
  {
    title: "Crisis Text Line",
    description: "Text HOME to 741741 for 24/7 crisis support.",
    link: "https://www.crisistextline.org",
    type: "Hotline"
  },
  {
    title: "Psychology Today",
    description: "Find therapists and mental health professionals in your area.",
    link: "https://www.psychologytoday.com",
    type: "Directory"
  },
  {
    title: "Headspace",
    description: "Meditation and mindfulness app for mental wellness.",
    link: "https://www.headspace.com",
    type: "App"
  },
  {
    title: "BetterHelp",
    description: "Online therapy platform connecting you with licensed therapists.",
    link: "https://www.betterhelp.com",
    type: "Service"
  }
];

export default function Resources() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const cardsRef = useRef<HTMLDivElement[]>([]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.fromTo(titleRef.current,
        { opacity: 0, scale: 0.8 },
        {
          opacity: 1,
          scale: 1,
          duration: 0.8,
          scrollTrigger: {
            trigger: sectionRef.current,
            start: "top 80%",
            toggleActions: "play none none reverse"
          }
        }
      );

      cardsRef.current.forEach((card, index) => {
        gsap.fromTo(card,
          { opacity: 0, rotateY: -90 },
          {
            opacity: 1,
            rotateY: 0,
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
    <section id="resources" ref={sectionRef} className="py-20 px-4 bg-white dark:bg-gray-800">
      <div className="max-w-6xl mx-auto">
        <h2 ref={titleRef} className="text-4xl font-bold text-center text-gray-800 dark:text-white mb-12">
          Helpful Resources
        </h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {resources.map((resource, index) => (
            <div
              key={resource.title}
              ref={(el) => { if (el) cardsRef.current[index] = el; }}
              className="bg-gray-50 dark:bg-gray-700 p-6 rounded-2xl shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105"
            >
              <div className="flex justify-between items-start mb-3">
                <h3 className="text-lg font-semibold text-gray-800 dark:text-white">
                  {resource.title}
                </h3>
                <span className="text-xs bg-indigo-100 dark:bg-indigo-900 text-indigo-800 dark:text-indigo-200 px-2 py-1 rounded-full">
                  {resource.type}
                </span>
              </div>
              <p className="text-gray-600 dark:text-gray-300 mb-4">
                {resource.description}
              </p>
              <a
                href={resource.link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium"
              >
                Visit Resource →
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}