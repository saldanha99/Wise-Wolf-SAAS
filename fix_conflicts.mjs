import fs from 'fs';
const files = [
  'components/LessonPlannerAI.tsx',
  'components/StudentsList.tsx',
  'components/TeacherManagement.tsx',
  'components/TeacherScheduleExplorer.tsx'
];
const replacements = [
  { regex: /bg-white dark:bg-slate-900/g, replacement: "bg-brand-surface" },
  { regex: /bg-slate-50 dark:bg-slate-800/g, replacement: "bg-brand-surface-2" },
  { regex: /bg-white/g, replacement: "bg-brand-surface" },
  { regex: /bg-slate-50/g, replacement: "bg-brand-surface-2" },
  { regex: /bg-slate-100/g, replacement: "bg-brand-surface-2" },
  { regex: /bg-slate-900/g, replacement: "bg-brand-surface" },
  { regex: /bg-slate-800/g, replacement: "bg-brand-surface-2" },
  { regex: /text-slate-800 dark:text-white/g, replacement: "text-brand-text" },
  { regex: /text-slate-900 dark:text-white/g, replacement: "text-brand-text" },
  { regex: /text-slate-500 dark:text-slate-400/g, replacement: "text-brand-muted" },
  { regex: /text-slate-600 dark:text-slate-300/g, replacement: "text-brand-muted" },
  { regex: /text-slate-400 dark:text-slate-500/g, replacement: "text-brand-muted" },
  { regex: /text-slate-800/g, replacement: "text-brand-text" },
  { regex: /text-slate-900/g, replacement: "text-brand-text" },
  { regex: /text-slate-700/g, replacement: "text-brand-text" },
  { regex: /text-slate-600/g, replacement: "text-brand-muted" },
  { regex: /text-slate-500/g, replacement: "text-brand-muted" },
  { regex: /text-slate-400/g, replacement: "text-brand-muted" },
  { regex: /border-slate-100 dark:border-slate-800/g, replacement: "border-brand-border" },
  { regex: /border-slate-200 dark:border-slate-700/g, replacement: "border-brand-border" },
  { regex: /border-slate-300 dark:border-slate-700/g, replacement: "border-brand-border" },
  { regex: /border-slate-100/g, replacement: "border-brand-border" },
  { regex: /border-slate-200/g, replacement: "border-brand-border" },
  { regex: /border-slate-300/g, replacement: "border-brand-border" },
  { regex: /border-slate-700/g, replacement: "border-brand-border" },
  { regex: /border-slate-800/g, replacement: "border-brand-border" }
];
files.forEach(filePath => {
  let content = fs.readFileSync(filePath, 'utf8');
  replacements.forEach(({ regex, replacement }) => {
    content = content.replace(regex, replacement);
  });
  fs.writeFileSync(filePath, content);
});
