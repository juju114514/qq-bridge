import http.server, functools, sys, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.getcwd())
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8795), Handler)
print("serving on 8795")
srv.serve_forever()