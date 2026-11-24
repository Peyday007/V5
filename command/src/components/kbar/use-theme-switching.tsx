import { useRegisterActions } from 'kbar';
import { useTheme } from 'next-themes';

const useThemeSwitching = () => {
  const { theme, setTheme } = useTheme();
  useRegisterActions(
    [
      {
        id: 'toggleTheme',
        name: 'Toggle light / dark',
        shortcut: ['d', 'd'],
        section: 'Theme',
        perform: () => setTheme(theme === 'light' ? 'dark' : 'light')
      }
    ],
    [theme]
  );
};

export default useThemeSwitching;
