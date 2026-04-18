import Hero from './components/Hero';
import About from './components/About';
import CommonIssues from './components/CommonIssues';
import Resources from './components/Resources';
import Tips from './components/Tips';
import Contact from './components/Contact';
import Footer from './components/Footer';
import Navbar from './components/Navbar';

export default function Home() {
  return (
    <main className="overflow-x-hidden">
      <Navbar />
      <Hero />
      <About />
      <CommonIssues />
      <Resources />
      <Tips />
      <Contact />
      <Footer />
    </main>
  );
}