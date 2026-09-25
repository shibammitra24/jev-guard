import { renderComparison, runBaseline } from './baseline';
if (require.main === module) void runBaseline().then(result => console.log(renderComparison(result)));
