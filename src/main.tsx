import { render } from 'preact';
import '../design/tokens.css';
import '../design/components.css';
import { App } from './App';

render(<App />, document.getElementById('app')!);
