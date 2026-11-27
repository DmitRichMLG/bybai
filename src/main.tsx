import { render } from 'preact';
import '../design/tokens.css';
import '../design/components.css';
import { App } from './App';
import { Hud } from './Hud';
import { view } from './transport';

// Одна страница на оба окна: главное и плашку поверх экранов.
render(view === 'hud' ? <Hud /> : <App />, document.getElementById('app')!);
