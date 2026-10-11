#include <X11/Xlib.h>
#include <X11/Xatom.h>
extern "C" {
#include <xdo.h>
}
#include <unistd.h>
#include <clocale>
#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

// Only used for the exclusive, human-operated administrator sign-in window.
// No DevTools connection, JavaScript evaluation or browser fingerprint changes.
static int ignoreXError(Display*, XErrorEvent*) { return 0; }
static unsigned long property(Display* d, Window w, const char* name) {
  Atom type; int format; unsigned long n, remaining; unsigned char* data=nullptr;
  unsigned long value=0;
  if(XGetWindowProperty(d,w,XInternAtom(d,name,False),0,1,False,AnyPropertyType,
      &type,&format,&n,&remaining,&data)==Success && data) {
    if(format==32 && n) value=*(unsigned long*)data;
    XFree(data);
  }
  return value;
}
static Window browserWindow(Display* d, unsigned long pid) {
  Atom type; int format; unsigned long n, remaining; unsigned char* data=nullptr;
  Window result=0;
  if(XGetWindowProperty(d,DefaultRootWindow(d),XInternAtom(d,"_NET_CLIENT_LIST_STACKING",False),
      0,4096,False,XA_WINDOW,&type,&format,&n,&remaining,&data)==Success && data) {
    if(format==32) for(long i=(long)n-1;i>=0;i--) {
      Window w=((Window*)data)[i]; XWindowAttributes a;
      if(property(d,w,"_NET_WM_PID")==pid && XGetWindowAttributes(d,w,&a) && a.map_state==IsViewable) {
        result=w; break;
      }
    }
    XFree(data);
  }
  return result;
}
static std::string unhex(const std::string& value) {
  if(value.size()%2 || value.size()>262144) return {};
  std::string result; result.reserve(value.size()/2);
  const auto digit=[](char c)->int {if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;};
  for(size_t i=0;i<value.size();i+=2) {
    int a=digit(value[i]),b=digit(value[i+1]);if(a<0||b<0)return {};
    char c=(a<<4)|b;if(!c)return {};result.push_back(c);
  }
  return result;
}
static void closeBrowserWindows(Display* d,unsigned long pid) {
  Atom type;int format;unsigned long count,remaining;unsigned char* data=nullptr;
  Window root=DefaultRootWindow(d);
  if(XGetWindowProperty(d,root,XInternAtom(d,"_NET_CLIENT_LIST",False),0,4096,False,XA_WINDOW,
      &type,&format,&count,&remaining,&data)==Success&&data) {
    if(format==32)for(unsigned long i=0;i<count;i++) {
      Window w=((Window*)data)[i];if(property(d,w,"_NET_WM_PID")!=pid)continue;
      XEvent event{};event.xclient.type=ClientMessage;event.xclient.window=w;
      event.xclient.message_type=XInternAtom(d,"_NET_CLOSE_WINDOW",False);event.xclient.format=32;
      event.xclient.data.l[0]=CurrentTime;event.xclient.data.l[1]=2;
      XSendEvent(d,root,False,SubstructureNotifyMask|SubstructureRedirectMask,&event);
    }
    XFree(data);
  }
}
int main(int argc,char** argv) {
  if(argc!=2)return 2;
  setlocale(LC_ALL,"C.UTF-8");
  const unsigned long pid=std::stoul(argv[1]);
  xdo_t* xdo=xdo_new(nullptr);if(!xdo)return 3;
  Display* d=xdo->xdpy;XSetErrorHandler(ignoreXError);
  Window window=0;std::string line;
  while(std::getline(std::cin,line)) {
    std::istringstream in(line);unsigned long request=0;std::string command;in>>request>>command;
    Window found=browserWindow(d,pid);bool changed=found && found!=window;
    if(found)window=found;
    XWindowAttributes a{};bool valid=window && XGetWindowAttributes(d,window,&a) && a.map_state==IsViewable;
    if(!valid) {
      if(request)std::cout<<"{\"request\":"<<request<<",\"ok\":false,\"error\":\"window_unavailable\"}"<<std::endl;
      continue;
    }
    if(changed){xdo_activate_window(xdo,window);xdo_focus_window(xdo,window);}
    if(command=="resize") {
      int width,height;in>>width>>height;
      if(width>=320 && width<=8192 && height>=240 && height<=4320) {
        XMoveResizeWindow(d,window,0,0,width,height);XSync(d,False);
      }
    } else if(command=="move") {
      int x,y;in>>x>>y;xdo_move_mouse_relative_to_window(xdo,window,
        std::max(0,std::min(a.width-1,x)),std::max(0,std::min(a.height-1,y)));
    } else if(command=="button") {
      int down,button;in>>down>>button;
      if(button>=1 && button<=9) {
        if(down)xdo_mouse_down(xdo,CURRENTWINDOW,button);else xdo_mouse_up(xdo,CURRENTWINDOW,button);
      }
    } else if(command=="key") {
      int down;std::string key;in>>down>>key;
      if(!key.empty() && key.size()<40 && key.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+")==std::string::npos) {
        if(down)xdo_send_keysequence_window_down(xdo,CURRENTWINDOW,key.c_str(),0);
        else xdo_send_keysequence_window_up(xdo,CURRENTWINDOW,key.c_str(),0);
      }
    } else if(command=="text") {
      std::string encoded;in>>encoded;std::string text=unhex(encoded);
      if(!text.empty()) {
        charcodemap_t* active=nullptr;int count=0;
        xdo_get_active_modifiers(xdo,&active,&count);
        xdo_clear_active_modifiers(xdo,CURRENTWINDOW,active,count);
        xdo_enter_text_window(xdo,CURRENTWINDOW,text.c_str(),12000);
        xdo_set_active_modifiers(xdo,CURRENTWINDOW,active,count);
        free(active);
      }
    } else if(command=="close") {
      closeBrowserWindows(d,pid);
    }
    XSync(d,False);
    if(request) {
      XGetWindowAttributes(d,window,&a);
      std::cout<<"{\"request\":"<<request<<",\"ok\":true,\"window\":"<<window
        <<",\"width\":"<<a.width<<",\"height\":"<<a.height<<"}"<<std::endl;
    }
  }
  xdo_free(xdo);return 0;
}
