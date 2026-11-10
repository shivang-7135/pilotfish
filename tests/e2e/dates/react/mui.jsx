// MUI X DesktopDatePicker (sectioned field + popper calendar, dayjs adapter). Commits through its React onChange only.
// The desktop variant is forced: plain DatePicker picks the mobile dialog in headless Chrome (no fine pointer).
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DesktopDatePicker } from '@mui/x-date-pickers/DesktopDatePicker';

function App() {
  const [value, setValue] = useState(null);
  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <DesktopDatePicker
        label="Start date"
        format="DD.MM.YYYY"
        value={value}
        onChange={(v) => {
          setValue(v);
          window.__commit('value', v == null ? '' : v.isValid() ? v.format('YYYY-MM-DD') : 'invalid');
        }}
      />
    </LocalizationProvider>
  );
}
createRoot(document.getElementById('root')).render(<App />);
