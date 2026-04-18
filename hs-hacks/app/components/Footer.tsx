export default function Footer() {
  return (
    <footer className="bg-gray-800 dark:bg-gray-900 text-white py-12 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="grid md:grid-cols-4 gap-8">
          <div>
            <h3 className="text-xl font-bold mb-4">MindWell</h3>
            <p className="text-gray-300">
              Supporting mental health and wellness for everyone.
            </p>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Quick Links</h4>
            <ul className="space-y-2 text-gray-300">
              <li><a href="#about" className="hover:text-white">About</a></li>
              <li><a href="#issues" className="hover:text-white">Common Issues</a></li>
              <li><a href="#resources" className="hover:text-white">Resources</a></li>
              <li><a href="#tips" className="hover:text-white">Tips</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Support</h4>
            <ul className="space-y-2 text-gray-300">
              <li><a href="#contact" className="hover:text-white">Contact Us</a></li>
              <li><a href="#" className="hover:text-white">Privacy Policy</a></li>
              <li><a href="#" className="hover:text-white">Terms of Service</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Emergency</h4>
            <p className="text-gray-300 mb-2">National Suicide Prevention Lifeline:</p>
            <p className="font-bold text-lg">1-800-273-8255</p>
            <p className="text-gray-300 mt-2">Available 24/7</p>
          </div>
        </div>
        <div className="border-t border-gray-700 mt-8 pt-8 text-center text-gray-300">
          <p>&copy; 2024 MindWell. All rights reserved. This is not a substitute for professional medical advice.</p>
        </div>
      </div>
    </footer>
  );
}