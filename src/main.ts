import './styles/theme.css';
import { initApp } from './app';
import { exposeCacheStats } from './cache/idb';

exposeCacheStats();

const root = document.getElementById('app');
if (root) void initApp(root);
