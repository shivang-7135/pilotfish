// react-datepicker with a German-style format. Commits through its React onChange only.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => (d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '');

function App() {
  const [date, setDate] = useState(null);
  return (
    <div>
      <label htmlFor="start">Start date</label>
      <DatePicker
        id="start"
        selected={date}
        onChange={(d) => {
          setDate(d);
          window.__commit('value', iso(d));
        }}
        dateFormat="dd.MM.yyyy"
        placeholderText="DD.MM.YYYY"
      />
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
